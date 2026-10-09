import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { WebSocket } from "ws";
import { RUNNERS, type ClientMessage, type RunnerId, type ServerMessage } from "../shared/protocol.js";
import { gitCommit, gitDiff, gitStatus } from "./git.js";
import { runCliPrompt } from "./runners/cli.js";
import { announceCursorSetting, answerCursorPermission, cancelCursor, configureCursor, pendingCursorPermissions } from "./runners/cursor-acp.js";
import { cancelPi, runPiPrompt, type RunnerEvents } from "./runners/pi.js";
import { browserStatus, ensureBrowser, navigateBrowser, phoneClick, phoneScroll, phoneType, setBrowserEmitters, setBrowserMobile, setChromeDebugPort, setPhoneControl, setScreencast, switchBrowserTab } from "./browser.js";
import { desktopPointer, setDesktopEmitters, setDesktopStream } from "./desktop-stream.js";
import {
  createSession,
  createTask,
  getAgent,
  getProject,
  getSession,
  getTask,
  listAgents,
  listProjects,
  listSessionInfos,
  publicSession,
  removeProject,
  sessionsFor,
  tasksFor,
  updateTask,
} from "./store.js";

const sockets = new Set<WebSocket>();
const browserWatchers = new Set<WebSocket>();
const desktopWatchers = new Set<WebSocket>();

setBrowserEmitters(
  (frame) => {
    for (const socket of browserWatchers) send(socket, { type: "browser_frame", ...frame });
  },
  (status) => broadcast({ type: "browser_status", ...status }),
);

setDesktopEmitters((frame) => {
  for (const socket of desktopWatchers) send(socket, { type: "desktop_frame", ...frame });
});

export function addSocket(socket: WebSocket): void {
  sockets.add(socket);
  send(socket, { type: "ready", cwd: process.cwd() });
  send(socket, { type: "catalog", projects: listProjects(), agents: listAgents(), sessions: listSessionInfos() });
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
        throw new Error("请在配置页登记项目，并绑定 agent");
      case "remove_project":
        await removeProject(message.projectId);
        broadcastCatalog();
        return;
      case "open_project":
        sendProject(socket, message.projectId);
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
          send(socket, { type: "browser_status", ...browserStatus() });
        } else {
          browserWatchers.delete(socket);
          if (browserWatchers.size === 0) await setScreencast(false);
        }
        return;
      case "browser_control":
        send(socket, { type: "browser_status", ...setPhoneControl(message.on) });
        return;
      case "browser_mobile":
        send(socket, { type: "browser_status", ...await setBrowserMobile(message.on, message.width, message.height, message.scale) });
        return;
      case "browser_nav":
        await navigateBrowser(message.url);
        return;
      case "browser_switch":
        await switchBrowserTab(message.targetId);
        return;
      case "browser_port":
        send(socket, { type: "browser_status", ...await setChromeDebugPort(message.port) });
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
) {
  if (!text.trim()) throw new Error("消息是空的");
  const project = projectId ? mustProject(projectId) : null;
  const boundId = project ? project.agentId : agentId;
  if (project && !boundId) throw new Error("项目还没绑定 agent");
  const agent = getAgent(boundId);
  if (!agent || !RUNNERS.includes(agent.runner)) throw new Error("agent 不存在");
  const session = await createSession({
    id: randomUUID(),
    projectId: project?.id ?? null,
    agentId: agent.id,
    runner: agent.runner,
    title: text.trim().slice(0, 48),
  });
  broadcast({ type: "session", session: publicSession(session), messages: [] });
  void dispatch(session.id, project?.path ?? directDir(), agent.runner, text, images);
  return session;
}

async function continueSession(
  sessionId: string,
  text: string,
  images?: { mediaType: string; data: string }[],
) {
  const session = getSession(sessionId);
  if (!session) throw new Error("会话不存在");
  const project = session.projectId ? getProject(session.projectId) : undefined;
  if (!text.trim()) throw new Error("消息是空的");
  void dispatch(session.id, project?.path ?? directDir(), session.runner, text, images);
}

function runnerEvents(): RunnerEvents {
  return {
    onDelta: (id, delta) => broadcast({ type: "delta", sessionId: id, text: delta }),
    onTool: (id, phase, name) => broadcast({ type: "tool", sessionId: id, phase, name }),
    onLog: (id, line) => broadcast({ type: "log", sessionId: id, text: line }),
    onStatus: (id) => {
      const session = getSession(id);
      if (session) broadcast({ type: "session_patch", session: publicSession(session) });
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
) {
  const events = runnerEvents();
  if (runner === "pi") return runPiPrompt({ sessionId, cwd, text, images, events });
  return runCliPrompt({ sessionId, cwd, runner, text, images, events });
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
