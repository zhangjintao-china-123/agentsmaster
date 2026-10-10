import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Agent, ChatMessage, Project, RunnerId, SessionInfo, Task } from "../shared/protocol.js";
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

type Database = {
  projects: Project[];
  agents: Agent[];
  sessions: StoredSession[];
  tasks: Task[];
};

const dataDir = path.resolve("data");
const dataFile = path.join(dataDir, "store.json");

const empty: Database = { projects: [], agents: [], sessions: [], tasks: [] };

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
  await persist();
}

export function sessionsFor(projectId: string): SessionInfo[] {
  return db.sessions
    .filter((session) => session.projectId === projectId)
    .map(toInfo);
}

export function listSessionInfos(): SessionInfo[] {
  return db.sessions.map(toInfo);
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
