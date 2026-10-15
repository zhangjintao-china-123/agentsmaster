import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { ADMIN_AGENT_ID, RUNNERS, type ClientMessage, type RunnerId, type ServerMessage } from "../shared/protocol.js";
import { gitCommit, gitDiff, gitStatus } from "./git.js";
import { runCliPrompt } from "./runners/cli.js";
import { announceCursorSetting, answerCursorPermission, cancelCursor, configureCursor, pendingCursorPermissions } from "./runners/cursor-acp.js";
import { cancelPi, runPiPrompt, type RunnerEvents } from "./runners/pi.js";
import { browserStatus, ensureBrowser, navigateBrowser, phoneClick, phoneScroll, phoneType, setBrowserEmitters, setBrowserMobile, setChromeDebugPort, setPhoneControl, setScreencast, switchBrowserTab } from "./browser.js";
import { alignChromeMcp, chromeMcpStatus, type McpCheckInput } from "./chrome-mcp.js";
import { desktopPointer, setDesktopEmitters, setDesktopStream } from "./desktop-stream.js";
import { planRoom, readMentions, roomModelText } from "./rooms.js";
import {
  activateRoomSession,
  addRoom,
  addRoomJob,
  armRoomJob,
  consumeRoomJob,
  createSession,
  createTask,
  currentProjectSession,
  getAgent,
  getProject,
  getRoom,
  getSession,
  getTask,
  latestStartedProjectId,
  listAgents,
  listProjects,
  listRooms,
  listSessionInfos,
  listStoredRooms,
  publicSession,
  pushMessage,
  removeProject,
  removeRoom,
  roomForSession,
  roomJobForSession,
  sessionsFor,
  setRoomMembers,
  takeRoomJob,
  takeRoomRound,
  tasksFor,
  updateRoom,
  updateTask,
} from "./store.js";

const sockets = new Set<WebSocket>();
let openedProjectId: string | null = null;
let startedProjectId: string | null = null;
const browserWatchers = new Set<WebSocket>();
const desktopWatchers = new Set<WebSocket>();

setBrowserEmitters(
  (frame) => {
    for (const socket of browserWatchers) send(socket, { type: "browser_frame", ...frame });
  },
  (status) => broadcast({ type: "browser_status", ...status, mcp: mcpNow() }),
);

setDesktopEmitters((frame) => {
  for (const socket of desktopWatchers) send(socket, { type: "desktop_frame", ...frame });
});

export function addSocket(socket: WebSocket): void {
  sockets.add(socket);
  send(socket, { type: "ready", cwd: process.cwd() });
  send(socket, { type: "catalog", projects: listProjects(), agents: listAgents(), sessions: listSessionInfos() });
  send(socket, { type: "rooms", rooms: listRooms() });
  for (const ask of pendingCursorPermissions()) send(socket, { type: "permission", ...ask });
  socket.on("close", () => {
    sockets.delete(socket);
    browserWatchers.delete(socket);
    if (browserWatchers.size === 0) void setScreencast(false).catch(() => undefined);
    desktopWatchers.delete(socket);
    if (desktopWatchers.size === 0) void setDesktopStream(false).catch(() => undefined);
  });
  socket.on("message", (raw) => {
    void handle(socket, raw.toString());
  });
}

async function handle(socket: WebSocket, raw: string): Promise<void> {
  let message: ClientMessage;
  try {
    message = JSON.parse(raw) as ClientMessage;
  } catch {
    send(socket, { type: "error", message: "无法解析消息" });
    return;
  }

  try {
    switch (message.type) {
      case "add_cwd":
      case "add_project":
        throw new Error("请在配置页登记项目");
      case "remove_project":
        await removeProject(message.projectId);
        broadcastCatalog();
        return;
      case "open_project":
        openedProjectId = message.projectId;
        sendProject(socket, message.projectId);
        broadcast({ type: "browser_status", ...browserStatus(), mcp: mcpNow() });
        return;
      case "open_session": {
        const session = getSession(message.sessionId);
        if (!session) throw new Error("会话不存在");
        send(socket, { type: "session", session: publicSession(session), messages: session.messages });
        const ask = pendingCursorPermissions().find((item) => item.sessionId === session.id);
        if (ask) send(socket, { type: "permission", ...ask });
        if (session.runner === "cursor") void announceCursorSetting(session.id, runnerEvents());
        return;
      }
      case "cancel": {
        const session = getSession(message.sessionId);
        if (!session) throw new Error("会话不存在");
        const stopped = session.runner === "cursor" ? cancelCursor(session.id) : session.runner === "pi" ? cancelPi(session.id) : false;
        if (!stopped) throw new Error("现在没有可以停止的回复");
        return;
      }
      case "cursor_setting":
        await configureCursor(message.sessionId, { model: message.model, fast: message.fast }, runnerEvents());
        return;
      case "browser_watch":
        if (message.on) {
          browserWatchers.add(socket);
          await ensureBrowser();
          await setScreencast(true);
          send(socket, { type: "browser_status", ...browserStatus(), mcp: mcpNow() });
        } else {
          browserWatchers.delete(socket);
          if (browserWatchers.size === 0) await setScreencast(false);
        }
        return;
      case "browser_control":
        send(socket, { type: "browser_status", ...setPhoneControl(message.on), mcp: mcpNow() });
        return;
      case "browser_mobile":
        send(socket, { type: "browser_status", ...await setBrowserMobile(message.on, message.width, message.height, message.scale), mcp: mcpNow() });
        return;
      case "browser_nav":
        await navigateBrowser(message.url);
        return;
      case "browser_switch":
        await switchBrowserTab(message.targetId);
        return;
      case "browser_port":
        send(socket, { type: "browser_status", ...await setChromeDebugPort(message.port), mcp: mcpNow() });
        return;
      case "browser_mcp_align":
        broadcast({ type: "browser_status", ...browserStatus(), mcp: mcpAlign() });
        return;
      case "browser_input":
        if (message.kind === "click") await phoneClick(message.x, message.y);
        else if (message.kind === "wheel") await phoneScroll(message.x, message.y, message.deltaX, message.deltaY);
        else await phoneType(message.text);
        return;
      case "desktop_watch":
        if (message.on) {
          desktopWatchers.add(socket);
          await setDesktopStream(true);
        } else {
          desktopWatchers.delete(socket);
          if (desktopWatchers.size === 0) await setDesktopStream(false);
        }
        return;
      case "desktop_input":
        await desktopPointer(message);
        return;
      case "start":
        await startSession(message.agentId, message.projectId ?? null, message.text, message.images);
        return;
      case "prompt":
        await continueSession(message.sessionId, message.text, message.images);
        return;
      case "permission": {
        const accepted = answerCursorPermission(message.sessionId, message.requestId, message.optionId);
        if (!accepted) throw new Error("这个确认已经处理过");
        return;
      }
      case "git_status": {
        const project = mustProject(message.projectId);
        const status = await gitStatus(project.path);
        send(socket, { type: "git_status", projectId: project.id, ...status });
        return;
      }
      case "git_diff": {
        const project = mustProject(message.projectId);
        const diff = await gitDiff(project.path, message.path);
        send(socket, { type: "git_diff", projectId: project.id, ...diff });
        return;
      }
      case "git_commit": {
        const project = mustProject(message.projectId);
        const result = await gitCommit(project.path, message.message);
        broadcast({ type: "committed", projectId: project.id, ...result });
        const status = await gitStatus(project.path);
        broadcast({ type: "git_status", projectId: project.id, ...status });
        return;
      }
      case "add_task": {
        const project = mustProject(message.projectId);
        if (!message.title.trim()) throw new Error("任务标题是空的");
        await createTask(project.id, message.title);
        broadcastProject(project.id);
        return;
      }
      case "start_task": {
        const task = getTask(message.taskId);
        if (!task) throw new Error("任务不存在");
        const session = await startSession("", task.projectId, task.title);
        await updateTask(task.id, { status: "doing", sessionId: session.id });
        broadcastProject(task.projectId);
        return;
      }
      case "add_room": {
        const name = message.name.trim();
        const rules = message.rules.trim();
        if (!name) throw new Error("先写会议室名称");
        if (!rules) throw new Error("先写工作规则");
        const session = await createRoomHost(name);
        await addRoom({ name, rules, sessionId: session.id, members: message.members });
        broadcastRooms();
        return;
      }
      case "update_room":
        await updateRoom(message.roomId, { name: message.name, rules: message.rules, maxRounds: message.maxRounds });
        broadcastRooms();
        return;
      case "set_room_members":
        await setRoomMembers(message.roomId, message.members);
        broadcastRooms();
        return;
      case "remove_room":
        await removeRoom(message.roomId);
        broadcastRooms();
        return;
      case "new_room_session": {
        const room = getRoom(message.roomId);
        if (!room) throw new Error("会议室不存在");
        const session = await createRoomHost(room.name);
        await activateRoomSession(room.id, session.id, true);
        broadcastRooms();
        broadcast({ type: "session", session: publicSession(session), messages: [] });
        return;
      }
      case "open_room_session": {
        const room = getRoom(message.roomId);
        if (!room) throw new Error("会议室不存在");
        const session = getSession(message.sessionId);
        if (!session) throw new Error("会话不存在");
        await activateRoomSession(room.id, session.id, false);
        broadcastRooms();
        broadcast({ type: "session", session: publicSession(session), messages: session.messages });
        return;
      }
      case "room_say": {
        const room = getRoom(message.roomId);
        if (!room) throw new Error("会议室不存在");
        const text = message.text.trim();
        if (!text) throw new Error("消息是空的");
        const seated = memberBrief(room);
        const mentioned = readMentions(text, seated);
        if (mentioned.missing.length > 0) {
          throw new Error(`会上没有叫「${mentioned.missing.join("、")}」的人，用与会者的名字或职责来 @`);
        }
        if (mentioned.targets.length > 0) {
          await pushMessage(room.sessionId, { id: randomUUID(), role: "user", text, at: Date.now() });
          const latest = getSession(room.sessionId);
          if (latest) broadcast({ type: "session", session: publicSession(latest), messages: latest.messages });
          for (const target of mentioned.targets) {
            await deliverToMember(target.projectId, text, room.id);
          }
          return;
        }
        await continueSession(room.sessionId, roomModelText(room, seated, `用户说：\n${text}`), undefined, text);
        return;
      }
      default:
        send(socket, { type: "error", message: "未知消息" });
    }
  } catch (error) {
    send(socket, {
      type: "error",
      message: error instanceof Error ? error.message : "请求失败",
    });
  }
}

async function startSession(
  agentId: string,
  projectId: string | null,
  text: string,
  images?: { mediaType: string; data: string }[],
  options?: { background?: boolean; roomId?: string },
) {
  if (!text.trim()) throw new Error("消息是空的");
  const project = projectId ? mustProject(projectId) : null;
  const boundId = project ? project.agentId : agentId;
  if (project && !boundId) throw new Error("项目还没有通道");
  const agent = getAgent(boundId);
  if (!agent || !RUNNERS.includes(agent.runner)) throw new Error("agent 不存在");
  const session = await createSession({
    id: randomUUID(),
    projectId: project?.id ?? null,
    agentId: agent.id,
    runner: agent.runner,
    title: text.trim().slice(0, 48),
  });
  if (options?.roomId && project) {
    const room = getRoom(options.roomId);
    await addRoomJob(options.roomId, { sessionId: session.id, projectId: project.id, hostSessionId: room?.sessionId, wait: 1 });
  }
  broadcast({ type: "session", session: publicSession(session), messages: [], background: options?.background });
  if (project) {
    startedProjectId = project.id;
    broadcast({ type: "browser_status", ...browserStatus(), mcp: mcpNow() });
  }
  void dispatch(session.id, project?.path ?? directDir(), agent.runner, text, images);
  return session;
}

async function continueSession(
  sessionId: string,
  text: string,
  images?: { mediaType: string; data: string }[],
  shown?: string,
  options?: { hidden?: boolean },
) {
  const session = getSession(sessionId);
  if (!session) throw new Error("会话不存在");
  const project = session.projectId ? getProject(session.projectId) : undefined;
  if (!text.trim()) throw new Error("消息是空的");
  void dispatch(session.id, project?.path ?? directDir(), session.runner, text, images, shown, options?.hidden);
}

function runnerEvents(): RunnerEvents {
  return {
    onDelta: (id, delta) => broadcast({ type: "delta", sessionId: id, text: delta }),
    onTool: (id, phase, name) => broadcast({ type: "tool", sessionId: id, phase, name }),
    onLog: (id, line) => broadcast({ type: "log", sessionId: id, text: line }),
    onStatus: (id) => {
      const session = getSession(id);
      if (!session) return;
      if (roomForSession(id)) broadcast({ type: "session", session: publicSession(session), messages: session.messages });
      else if (roomJobForSession(id)) broadcast({ type: "session", session: publicSession(session), messages: session.messages, background: true });
      else broadcast({ type: "session_patch", session: publicSession(session) });
      if (session.status === "done" || session.status === "error") void settleRoom(session);
    },
    onPermission: (id, ask) => broadcast({ type: "permission", sessionId: id, ...ask }),
    onCursorSetting: (id, setting) => broadcast({ type: "cursor_setting", sessionId: id, ...setting }),
  };
}

function dispatch(
  sessionId: string,
  cwd: string,
  runner: RunnerId,
  text: string,
  images?: { mediaType: string; data: string }[],
  shown?: string,
  hidden?: boolean,
) {
  const events = runnerEvents();
  if (runner === "pi") return runPiPrompt({ sessionId, cwd, text, shown, hidden, images, events });
  return runCliPrompt({ sessionId, cwd, runner, text, images, events });
}

async function deliverToMember(projectId: string, text: string, roomId: string) {
  const project = mustProject(projectId);
  if (!project.agentId) throw new Error("项目还没有通道");
  const agent = getAgent(project.agentId);
  if (!agent || !RUNNERS.includes(agent.runner)) throw new Error("agent 不存在");
  const room = getRoom(roomId);
  if (!room) throw new Error("会议室不存在");
  const current = currentProjectSession(project.id, agent.id);
  if (!current) return startSession("", project.id, text, undefined, { background: true, roomId });
  await armRoomJob(room.id, {
    sessionId: current.id,
    projectId: project.id,
    hostSessionId: room.sessionId,
    busy: current.status === "working",
    separateTurns: agent.runner === "pi" || agent.runner === "cursor",
  });
  void continueSession(current.id, text);
  return current;
}

async function createRoomHost(title: string) {
  const agent = listAgents().find((item) => item.runner === "pi" && item.id !== ADMIN_AGENT_ID);
  if (!agent) throw new Error("会议室需要 Pi 通道");
  return createSession({
    id: randomUUID(),
    projectId: null,
    agentId: agent.id,
    runner: "pi",
    title: title.slice(0, 48) || "会议室",
  });
}

function memberBrief(room: { members: { projectId: string; role: string }[] }): { projectId: string; name: string; role: string }[] {
  return room.members.flatMap((member) => {
    const name = getProject(member.projectId)?.name;
    return name ? [{ projectId: member.projectId, name, role: member.role }] : [];
  });
}

async function settleRoom(session: NonNullable<ReturnType<typeof getSession>>): Promise<void> {
  if (session.status !== "done" && session.status !== "error") return;
  const agentText = [...session.messages].reverse().find((item) => item.role === "agent")?.text ?? "";
  const plan = planRoom({
    sessionId: session.id,
    status: session.status,
    summary: session.summary,
    agentText,
    rooms: listStoredRooms(),
    projects: listProjects().map((item) => ({ id: item.id, name: item.name })),
  });
  if (plan.type === "none") return;
  if (plan.type === "skip") {
    const room = getRoom(plan.roomId);
    if (!room) return;
    await pushMessage(room.sessionId, { id: randomUUID(), role: "agent", text: plan.text });
    const latest = getSession(room.sessionId);
    if (latest) broadcast({ type: "session", session: publicSession(latest), messages: latest.messages });
    return;
  }
  if (plan.type === "report") {
    const gate = await consumeRoomJob(session.id);
    if (gate === "wait") return;
    await takeRoomJob(session.id);
    const room = getRoom(plan.roomId);
    if (!room) return;
    const verb = plan.status === "error" ? "失败了" : "做完了";
    const seated = memberBrief(room);
    const speaker = seated.find((member) => member.projectId === plan.projectId);
    const who = speaker?.role ? `${plan.projectName}（${speaker.role}）` : plan.projectName;
    const hostId = plan.hostSessionId || room.sessionId;
    await pushMessage(hostId, { id: randomUUID(), role: "agent", text: `**${who}**\n\n${plan.detail}`, at: Date.now() });
    if (hostId !== room.sessionId) {
      const parked = getSession(hostId);
      if (parked) broadcast({ type: "session", session: publicSession(parked), messages: parked.messages });
      return;
    }
    const asked = [...(getSession(room.sessionId)?.messages ?? [])].reverse().find((item) => item.role === "user" && item.text.includes("@"));
    const body = `${asked ? `用户在会上说：\n${asked.text}\n\n` : ""}与会者「${who}」${verb}。\n结果：\n${plan.detail}`;
    await continueSession(room.sessionId, roomModelText(room, seated, body), undefined, undefined, { hidden: true });
    return;
  }
  const gate = await takeRoomRound(plan.roomId);
  if (!gate.allowed) {
    const room = getRoom(plan.roomId);
    if (!room) return;
    await pushMessage(room.sessionId, { id: randomUUID(), role: "agent", text: `已到最大轮次 ${gate.maxRounds}，这轮不再派人。`, at: Date.now() });
    const latest = getSession(room.sessionId);
    if (latest) broadcast({ type: "session", session: publicSession(latest), messages: latest.messages });
    return;
  }
  await deliverToMember(plan.projectId, plan.task, plan.roomId);
}

function broadcastRooms() {
  broadcast({ type: "rooms", rooms: listRooms() });
}

function directDir(): string {
  const dir = path.join(os.homedir(), ".agentsmaster", "inbox");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function broadcastCatalog() {
  broadcast({
    type: "catalog",
    projects: listProjects(),
    agents: listAgents(),
    sessions: listSessionInfos(),
  });
}

export { broadcastCatalog };

function mcpNow() {
  return chromeMcpStatus(mcpCheckInput());
}

function mcpAlign() {
  return alignChromeMcp(mcpCheckInput());
}

function mcpCheckInput(): McpCheckInput {
  const projects = listProjects().filter((project) => project.runner !== "pi");
  const opened = openedProjectId ? getProject(openedProjectId) : undefined;
  if (opened && opened.runner !== "pi") return { focus: opened, focusSource: "open", projects };
  const started = startedProjectId ? getProject(startedProjectId) : undefined;
  if (started && started.runner !== "pi") return { focus: started, focusSource: "started", projects };
  const latestId = latestStartedProjectId();
  const latest = latestId ? getProject(latestId) : undefined;
  if (latest && latest.runner !== "pi") return { focus: latest, focusSource: "started", projects };
  return { focus: projects[0] ?? null, focusSource: "listed", projects };
}

function mustProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) throw new Error("项目不存在");
  return project;
}

function sendProject(socket: WebSocket, projectId: string) {
  const project = mustProject(projectId);
  send(socket, {
    type: "project",
    project,
    sessions: sessionsFor(project.id),
    tasks: tasksFor(project.id),
  });
}

function broadcastProject(projectId: string) {
  const project = getProject(projectId);
  if (!project) return;
  broadcast({
    type: "project",
    project,
    sessions: sessionsFor(project.id),
    tasks: tasksFor(project.id),
  });
}

function broadcast(message: ServerMessage) {
  for (const socket of sockets) send(socket, message);
}

function send(socket: WebSocket, message: ServerMessage) {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message));
}
