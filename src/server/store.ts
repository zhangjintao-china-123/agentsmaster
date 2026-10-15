import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, ChatMessage, Project, Room, RoomMember, RunnerId, SessionInfo, Task } from "../shared/protocol.js";
import { ADMIN_AGENT_ID, RUNNERS } from "../shared/protocol.js";

export type StoredSession = SessionInfo & {
  messages: ChatMessage[];
  externalId?: string;
  piSessionFile?: string;
  cursorAutoApprove?: boolean;
  cursorModel?: string;
  cursorEffort?: string;
  cursorFast?: boolean;
};

export type RoomJob = {
  sessionId: string;
  projectId: string;
  hostSessionId?: string;
  wait: number;
};

export type StoredRoom = Room & {
  jobs: RoomJob[];
  sessionRounds: Record<string, number>;
};

type Database = {
  projects: Project[];
  agents: Agent[];
  sessions: StoredSession[];
  tasks: Task[];
  rooms: StoredRoom[];
};

const dataDir = path.resolve("data");
const dataFile = path.join(dataDir, "store.json");

const empty: Database = { projects: [], agents: [], sessions: [], tasks: [], rooms: [] };

let db: Database = structuredClone(empty);
let writing: Promise<void> = Promise.resolve();

export async function loadStore(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  try {
    db = JSON.parse(await readFile(dataFile, "utf8")) as Database;
    db.projects ??= [];
    db.agents ??= [];
    db.sessions ??= [];
    db.tasks ??= [];
    db.rooms ??= [];
    for (const room of db.rooms) {
      const legacy = room as StoredRoom & { memberIds?: string[] };
      room.jobs ??= [];
      if (!Array.isArray(room.members)) {
        room.members = (legacy.memberIds ?? []).map((projectId) => ({ projectId, role: "" }));
      }
      delete legacy.memberIds;
      if (!Array.isArray(room.sessionIds) || room.sessionIds.length === 0) room.sessionIds = room.sessionId ? [room.sessionId] : [];
      if (room.sessionId && !room.sessionIds.includes(room.sessionId)) room.sessionIds.unshift(room.sessionId);
      room.maxRounds = normalizeMaxRounds(room.maxRounds);
      room.round = Number.isInteger(room.round) && room.round > 0 ? room.round : 0;
      room.sessionRounds ??= {};
      room.sessionRounds[room.sessionId] = room.round;
      for (const job of room.jobs) job.wait = Number.isInteger(job.wait) && job.wait > 0 ? job.wait : 1;
    }
    if (db.agents.length === 0) db.agents = defaultAgents();
    if (!db.agents.some((agent) => agent.id === ADMIN_AGENT_ID)) {
      db.agents.unshift({ id: ADMIN_AGENT_ID, name: "AI管理员", runner: "pi" });
    }
    for (const project of db.projects) {
      project.agentId ??= "";
      const bound = db.agents.find((agent) => agent.id === project.agentId);
      const runner = projectRunners.includes(project.runner) ? project.runner : bound && projectRunners.includes(bound.runner) ? bound.runner : "cursor";
      const agent = ensureRunnerAgent(runner);
      project.runner = runner;
      project.agentId = agent.id;
    }
    for (const session of db.sessions) {
      if (!session.agentId) {
        session.agentId = db.agents.find((agent) => agent.runner === session.runner)?.id ?? "";
      }
    }
    await persist();
  } catch {
    db = structuredClone(empty);
    await persist();
  }
}

function persist(): Promise<void> {
  writing = writing.then(() =>
    writeFile(dataFile, JSON.stringify(db, null, 2)),
  );
  return writing;
}

export function listAgents(): Agent[] {
  return db.agents;
}

export function getAgent(id: string): Agent | undefined {
  return db.agents.find((agent) => agent.id === id);
}

export async function addAgent(name: string, runner: RunnerId, model?: string): Promise<Agent> {
  if (!RUNNERS.includes(runner)) throw new Error("不支持的通道");
  const agent: Agent = { id: randomUUID(), name: name.trim(), runner };
  if (runner === "cursor" && model?.trim()) agent.model = model.trim();
  db.agents.unshift(agent);
  await persist();
  return agent;
}

export async function setAgentModel(id: string, model: string): Promise<Agent> {
  const agent = getAgent(id);
  if (!agent) throw new Error("agent 不存在");
  if (agent.runner !== "cursor") throw new Error("只有 Cursor 需要选择模型");
  const next = model.trim();
  if (next) agent.model = next;
  else delete agent.model;
  await persist();
  return agent;
}

export async function removeAgent(id: string): Promise<void> {
  if (id === ADMIN_AGENT_ID) throw new Error("AI管理员不能移除");
  db.agents = db.agents.filter((agent) => agent.id !== id);
  await persist();
}

function defaultAgents(): Agent[] {
  return [
    ["Pi", "pi"],
    ["Cursor", "cursor"],
    ["OpenCode", "opencode"],
    ["Claude", "claude"],
    ["Codex", "codex"],
  ].map(([name, runner]) => ({
    id: randomUUID(),
    name,
    runner: runner as RunnerId,
  }));
}

export function listProjects(): Project[] {
  return db.projects;
}

export function getProject(id: string): Project | undefined {
  return db.projects.find((project) => project.id === id);
}

const projectRunners: RunnerId[] = ["cursor", "opencode", "claude", "codex"];

function ensureRunnerAgent(runner: RunnerId): Agent {
  const existing = db.agents.find((agent) => agent.id !== ADMIN_AGENT_ID && agent.runner === runner);
  if (existing) return existing;
  const agent: Agent = { id: randomUUID(), name: runner, runner };
  db.agents.push(agent);
  return agent;
}

export async function addProject(projectPath: string, runner: RunnerId, name?: string): Promise<Project> {
  if (!projectRunners.includes(runner)) throw new Error("请选择通道");
  const agent = ensureRunnerAgent(runner);
  const resolved = path.resolve(projectPath);
  const existing = db.projects.find((project) => project.path === resolved);
  if (existing) {
    existing.runner = runner;
    existing.agentId = agent.id;
    if (name?.trim()) existing.name = name.trim();
    await persist();
    return existing;
  }
  const project: Project = {
    id: randomUUID(),
    name: name?.trim() || path.basename(resolved),
    path: resolved,
    agentId: agent.id,
    runner,
  };
  db.projects.unshift(project);
  await persist();
  return project;
}

export async function setProjectRunner(id: string, runner: RunnerId): Promise<Project> {
  if (!projectRunners.includes(runner)) throw new Error("请选择通道");
  const project = getProject(id);
  if (!project) throw new Error("项目不存在");
  const agent = ensureRunnerAgent(runner);
  project.runner = runner;
  project.agentId = agent.id;
  await persist();
  return project;
}

export async function removeProject(id: string): Promise<void> {
  db.projects = db.projects.filter((project) => project.id !== id);
  db.sessions = db.sessions.filter((session) => session.projectId !== id);
  db.tasks = db.tasks.filter((task) => task.projectId !== id);
  for (const room of db.rooms) {
    room.members = room.members.filter((member) => member.projectId !== id);
    room.jobs = room.jobs.filter((job) => job.projectId !== id);
  }
  await persist();
}

export function currentProjectSession(projectId: string, agentId: string): StoredSession | undefined {
  return db.sessions
    .filter((session) => session.projectId === projectId && session.agentId === agentId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
}

export function roomJobForSession(sessionId: string): boolean {
  return db.rooms.some((room) => room.jobs.some((job) => job.sessionId === sessionId));
}

export function sessionsFor(projectId: string): SessionInfo[] {
  return db.sessions
    .filter((session) => session.projectId === projectId)
    .map(toInfo);
}

export function listSessionInfos(): SessionInfo[] {
  return db.sessions.map(toInfo);
}

export function latestStartedProjectId(): string | null {
  for (const session of db.sessions) {
    if (session.projectId) return session.projectId;
  }
  return null;
}

export async function releaseOrphanedRuns(): Promise<string[]> {
  const released: string[] = [];
  for (const session of db.sessions) {
    if (session.status !== "working") continue;
    session.status = "error";
    session.summary = "上一次回复中断了";
    session.messages.push({
      id: randomUUID(),
      role: "log",
      text: "上一次回复中断了，可以继续输入",
      at: Date.now(),
    });
    released.push(session.id);
  }
  if (released.length > 0) await persist();
  return released;
}

export function getSession(id: string): StoredSession | undefined {
  return db.sessions.find((session) => session.id === id);
}

export function tasksFor(projectId: string): Task[] {
  return db.tasks.filter((task) => task.projectId === projectId);
}

export function getTask(id: string): Task | undefined {
  return db.tasks.find((task) => task.id === id);
}

export async function createSession(
  input: Omit<StoredSession, "messages" | "createdAt" | "summary" | "status"> & {
    status?: StoredSession["status"];
    summary?: string;
  },
): Promise<StoredSession> {
  const session: StoredSession = {
    ...input,
    status: input.status ?? "idle",
    summary: input.summary ?? "",
    createdAt: Date.now(),
    messages: [],
  };
  db.sessions.unshift(session);
  await persist();
  return session;
}

export async function updateSession(
  id: string,
  patch: Partial<StoredSession>,
): Promise<StoredSession | undefined> {
  const session = getSession(id);
  if (!session) return undefined;
  Object.assign(session, patch);
  await persist();
  return session;
}

export async function pushMessage(
  sessionId: string,
  message: ChatMessage,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  session.messages.push({ ...message, at: message.at ?? Date.now() });
  if (session.messages.length > 400) {
    session.messages.splice(0, session.messages.length - 400);
  }
  await persist();
}

export async function appendAgentText(sessionId: string, delta: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  const last = session.messages.at(-1);
  if (last?.role === "agent") last.text += delta;
  else {
    session.messages.push({ id: randomUUID(), role: "agent", text: delta, at: Date.now() });
  }
  const agent = [...session.messages].reverse().find((message) => message.role === "agent");
  if (agent) session.summary = agent.text.replace(/\s+/g, " ").slice(0, 120);
  await persist();
}

export async function createTask(projectId: string, title: string): Promise<Task> {
  const task: Task = {
    id: randomUUID(),
    projectId,
    title: title.trim(),
    status: "todo",
  };
  db.tasks.unshift(task);
  await persist();
  return task;
}

export async function updateTask(id: string, patch: Partial<Task>): Promise<Task | undefined> {
  const task = getTask(id);
  if (!task) return undefined;
  Object.assign(task, patch);
  await persist();
  return task;
}

function toInfo(session: StoredSession): SessionInfo {
  const {
    messages: _messages,
    externalId: _externalId,
    piSessionFile: _file,
    cursorAutoApprove: _auto,
    cursorModel: _model,
    cursorEffort: _effort,
    cursorFast: _fast,
    ...info
  } = session;
  return info;
}

export function publicSession(session: StoredSession): SessionInfo {
  return toInfo(session);
}

export function listRooms(): Room[] {
  return db.rooms.map(publicRoom);
}

export function listStoredRooms(): StoredRoom[] {
  return db.rooms;
}

export function getRoom(id: string): StoredRoom | undefined {
  return db.rooms.find((room) => room.id === id);
}

export function roomForSession(sessionId: string): StoredRoom | undefined {
  return db.rooms.find((room) => room.sessionId === sessionId);
}

export async function addRoom(input: { name: string; rules: string; sessionId: string; members: RoomMember[] }): Promise<Room> {
  const name = input.name.trim();
  const rules = input.rules.trim();
  if (!name) throw new Error("先写会议室名称");
  if (!rules) throw new Error("先写工作规则");
  const room: StoredRoom = {
    id: randomUUID(),
    name,
    rules,
    members: normalizeMembers(input.members),
    sessionId: input.sessionId,
    sessionIds: [input.sessionId],
    maxRounds: 200,
    round: 0,
    sessionRounds: { [input.sessionId]: 0 },
    jobs: [],
  };
  db.rooms.unshift(room);
  await persist();
  return publicRoom(room);
}

export async function updateRoom(id: string, patch: { name?: string; rules?: string; maxRounds?: number }): Promise<Room> {
  const room = getRoom(id);
  if (!room) throw new Error("会议室不存在");
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) throw new Error("会议室名称是空的");
    room.name = name;
  }
  if (patch.rules !== undefined) {
    const rules = patch.rules.trim();
    if (!rules) throw new Error("工作规则是空的");
    room.rules = rules;
  }
  if (patch.maxRounds !== undefined) {
    const max = Math.floor(Number(patch.maxRounds));
    if (!Number.isFinite(max) || max < 1) throw new Error("最大轮次至少是 1");
    if (max > 9999) throw new Error("最大轮次太大");
    room.maxRounds = max;
  }
  await persist();
  return publicRoom(room);
}

export async function activateRoomSession(id: string, sessionId: string, created: boolean): Promise<Room> {
  const room = getRoom(id);
  if (!room) throw new Error("会议室不存在");
  room.sessionRounds[room.sessionId] = room.round;
  if (created) {
    room.sessionIds = [sessionId, ...room.sessionIds.filter((item) => item !== sessionId)];
    room.round = 0;
  } else if (!room.sessionIds.includes(sessionId)) {
    throw new Error("会话不存在");
  } else {
    room.round = room.sessionRounds[sessionId] ?? 0;
  }
  room.sessionId = sessionId;
  room.sessionRounds[sessionId] = room.round;
  await persist();
  return publicRoom(room);
}

export async function takeRoomRound(id: string): Promise<{ allowed: boolean; round: number; maxRounds: number }> {
  const room = getRoom(id);
  if (!room) return { allowed: false, round: 0, maxRounds: 200 };
  const maxRounds = normalizeMaxRounds(room.maxRounds);
  if (room.round >= maxRounds) return { allowed: false, round: room.round, maxRounds };
  room.round += 1;
  room.sessionRounds[room.sessionId] = room.round;
  await persist();
  return { allowed: true, round: room.round, maxRounds };
}

export async function setRoomMembers(id: string, members: RoomMember[]): Promise<Room> {
  const room = getRoom(id);
  if (!room) throw new Error("会议室不存在");
  room.members = normalizeMembers(members);
  await persist();
  return publicRoom(room);
}

export async function removeRoom(id: string): Promise<void> {
  const room = getRoom(id);
  if (!room) throw new Error("会议室不存在");
  db.rooms = db.rooms.filter((item) => item.id !== id);
  const hostIds = new Set(room.sessionIds?.length ? room.sessionIds : [room.sessionId]);
  db.sessions = db.sessions.filter((session) => !hostIds.has(session.id));
  await persist();
}

export async function addRoomJob(roomId: string, job: RoomJob): Promise<void> {
  const room = getRoom(roomId);
  if (!room) return;
  room.jobs.push({ ...job, wait: job.wait > 0 ? job.wait : 1 });
  await persist();
}

export async function armRoomJob(
  roomId: string,
  input: { sessionId: string; projectId: string; hostSessionId?: string; busy: boolean; separateTurns: boolean },
): Promise<void> {
  const room = getRoom(roomId);
  if (!room) return;
  const job = room.jobs.find((item) => item.sessionId === input.sessionId);
  if (!job) {
    room.jobs.push({
      sessionId: input.sessionId,
      projectId: input.projectId,
      hostSessionId: input.hostSessionId,
      wait: input.busy && input.separateTurns ? 2 : 1,
    });
  } else if (input.busy && !input.separateTurns) {
    job.hostSessionId = input.hostSessionId;
  } else {
    job.wait = (job.wait > 0 ? job.wait : 1) + 1;
    job.hostSessionId = input.hostSessionId;
  }
  await persist();
}

export async function consumeRoomJob(sessionId: string): Promise<"wait" | "ready" | "none"> {
  for (const room of db.rooms) {
    const job = room.jobs.find((item) => item.sessionId === sessionId);
    if (!job) continue;
    job.wait = Math.max(0, (job.wait > 0 ? job.wait : 1) - 1);
    await persist();
    return job.wait > 0 ? "wait" : "ready";
  }
  return "none";
}

export async function takeRoomJob(sessionId: string): Promise<void> {
  for (const room of db.rooms) {
    const next = room.jobs.filter((job) => job.sessionId !== sessionId);
    if (next.length !== room.jobs.length) room.jobs = next;
  }
  await persist();
}

function publicRoom(room: StoredRoom): Room {
  return {
    id: room.id,
    name: room.name,
    rules: room.rules,
    members: room.members.map((member) => ({ projectId: member.projectId, role: member.role })),
    sessionId: room.sessionId,
    sessionIds: [...room.sessionIds],
    maxRounds: room.maxRounds,
    round: room.round,
  };
}

function normalizeMaxRounds(value: unknown): number {
  const max = Math.floor(Number(value));
  if (!Number.isFinite(max) || max < 1) return 200;
  return Math.min(max, 9999);
}

function normalizeMembers(members: RoomMember[]): RoomMember[] {
  const seen = new Set<string>();
  const next: RoomMember[] = [];
  for (const member of members) {
    const projectId = String(member?.projectId || "").trim();
    const role = String(member?.role || "").trim();
    if (!projectId || seen.has(projectId)) continue;
    if (!getProject(projectId)) throw new Error("成员不存在");
    if (!role) throw new Error("写清每个 Agent 的职责");
    seen.add(projectId);
    next.push({ projectId, role });
  }
  if (next.length === 0) throw new Error("先请 Agent 入座");
  return next;
}
