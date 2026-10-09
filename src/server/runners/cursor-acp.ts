import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { CursorModelChoice, ImagePayload, PermissionChange, PermissionOption } from "../../shared/protocol.js";
import { listCursorModels } from "../cursor-models.js";
import { resolveAgentLaunch } from "../cursor-cli.js";
import { appendAgentText, getAgent, getSession, pushMessage, updateSession } from "../store.js";
import type { RunnerEvents } from "./pi.js";

type RpcMessage = {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};

type PermissionAsk = {
  requestId: string;
  title: string;
  detail: string;
  options: PermissionOption[];
  changes: PermissionChange[];
  deadline: number;
};

type FastOption = { id: string; on: string; off: string };

type CatalogOption = {
  id?: string;
  name?: string;
  options?: Array<{ value?: string; name?: string }>;
};

type CatalogModel = {
  id: string;
  name: string;
  effort?: { id: string; values: Array<{ value: string; name: string }> };
  fast?: FastOption;
};

type Variant = { model: string; effort: string; fast: boolean };

type PermissionWaiter = {
  resolve: (optionId: string) => void;
  reject: (error: Error) => void;
  ask: PermissionAsk;
  timer: ReturnType<typeof setTimeout>;
};

type LiveCursor = {
  child: ChildProcessWithoutNullStreams | null;
  cwd: string;
  acpId?: string;
  ready: Promise<void> | null;
  nextId: number;
  pending: Map<number, Pending>;
  buffer: string;
  queue: Array<{ text: string; images: ImagePayload[] }>;
  running: boolean;
  models: CursorModelChoice[];
  catalog?: CatalogModel[];
  catalogLoading?: Promise<void>;
  fastOption?: FastOption;
  appliedModel?: string;
  appliedEffort?: string;
  appliedFastKey?: string;
};

let catalogCache: { at: number; models: CatalogModel[] } | null = null;

const live = new Map<string, LiveCursor>();
const permissions = new Map<string, PermissionWaiter>();
const permissionWaitMs = 45_000;

export function answerCursorPermission(sessionId: string, requestId: string, optionId: string): boolean {
  const key = permissionKey(sessionId, requestId);
  const waiter = permissions.get(key);
  if (!waiter) return false;
  clearTimeout(waiter.timer);
  permissions.delete(key);
  if (optionId === "allow-always" || waiter.ask.options.some((option) => option.id === optionId && option.kind === "allow_always")) {
    void updateSession(sessionId, { cursorAutoApprove: true });
  }
  waiter.resolve(optionId);
  return true;
}

export function pendingCursorPermissions(): Array<PermissionAsk & { sessionId: string }> {
  return [...permissions.entries()].map(([key, waiter]) => ({
    sessionId: key.slice(0, key.lastIndexOf(":")),
    ...waiter.ask,
  }));
}

export function cancelCursor(sessionId: string): boolean {
  const entry = live.get(sessionId);
  if (!entry?.child || !entry.acpId || !entry.running) return false;
  notify(entry, "session/cancel", { sessionId: entry.acpId });
  for (const [key, waiter] of permissions) {
    if (!key.startsWith(`${sessionId}:`)) continue;
    clearTimeout(waiter.timer);
    permissions.delete(key);
    waiter.reject(new Error("已停止"));
  }
  return true;
}

export async function announceCursorSetting(sessionId: string, events: RunnerEvents): Promise<void> {
  const setting = await cursorSetting(sessionId);
  if (setting) events.onCursorSetting?.(sessionId, setting);
}

export async function configureCursor(
  sessionId: string,
  patch: { model?: string; fast?: boolean },
  events: RunnerEvents,
): Promise<void> {
  const session = getSession(sessionId);
  if (!session || session.runner !== "cursor") throw new Error("这个会话不能改模型");
  if (patch.model !== undefined) {
    const decoded = decodeVariant(patch.model);
    if (decoded) await updateSession(sessionId, { cursorModel: decoded.model, cursorEffort: decoded.effort, cursorFast: decoded.fast });
    else await updateSession(sessionId, { cursorModel: patch.model });
  }
  if (patch.fast !== undefined) await updateSession(sessionId, { cursorFast: patch.fast });
  const entry = live.get(sessionId);
  if (entry?.acpId && entry.child) await alignCursor(entry, sessionId, events);
  else await announceCursorSetting(sessionId, events);
}

export async function runCursorPrompt(options: {
  sessionId: string;
  cwd: string;
  text: string;
  images?: ImagePayload[];
  events: RunnerEvents;
}): Promise<void> {
  const record = getSession(options.sessionId);
  if (!record) return;
  const text = options.text.trim();
  await pushMessage(options.sessionId, {
    id: randomUUID(),
    role: "user",
    text,
  });

  const entry = live.get(options.sessionId) ?? createEntry(options.cwd);
  entry.cwd = options.cwd;
  live.set(options.sessionId, entry);
  if (entry.running) {
    entry.queue.push({ text, images: options.images ?? [] });
    return;
  }
  await turn(options.sessionId, text, options.images ?? [], record.externalId, options.events);
}

function createEntry(cwd: string): LiveCursor {
  return {
    child: null,
    cwd,
    ready: null,
    nextId: 1,
    pending: new Map(),
    buffer: "",
    queue: [],
    running: false,
    models: [],
  };
}

async function turn(
  sessionId: string,
  text: string,
  images: ImagePayload[],
  externalId: string | undefined,
  events: RunnerEvents,
): Promise<void> {
  const entry = live.get(sessionId);
  if (!entry) return;
  entry.running = true;
  await updateSession(sessionId, { status: "working", summary: "正在运行" });
  events.onStatus(sessionId);
  try {
    await ensureProcess(sessionId, events);
    const current = live.get(sessionId);
    if (!current?.child) throw new Error("Cursor 没有启动");
    if (!current.acpId) {
      current.acpId = await openAcpSession(current, externalId);
      await updateSession(sessionId, { externalId: current.acpId });
    }
    await alignCursor(current, sessionId, events);
    const result = (await request(current, "session/prompt", {
      sessionId: current.acpId,
      prompt: promptBlocks(text, images),
    })) as { stopReason?: string };
    const stop = result?.stopReason;
    if (stop === "cancelled") {
      await pushMessage(sessionId, { id: randomUUID(), role: "log", text: "已停止" });
      events.onLog(sessionId, "已停止");
      await finish(sessionId, "done", "已停止", events);
    } else {
      await finish(sessionId, stop === "refusal" ? "error" : "done", stop === "refusal" ? "被拒绝" : "完成", events);
    }
  } catch (error) {
    const message = plainCursorError(error instanceof Error ? error.message : "Cursor 失败");
    if (/已停止|cancel/i.test(message)) {
      await pushMessage(sessionId, { id: randomUUID(), role: "log", text: "已停止" });
      events.onLog(sessionId, "已停止");
      await finish(sessionId, "done", "已停止", events);
    } else {
      await finish(sessionId, "error", message, events);
    }
  }
  const next = entry.queue.shift();
  entry.running = false;
  if (next) {
    const latest = getSession(sessionId);
    void turn(sessionId, next.text, next.images, latest?.externalId, events);
  }
}

async function finish(
  sessionId: string,
  status: "done" | "error",
  summary: string,
  events: RunnerEvents,
): Promise<void> {
  const current = getSession(sessionId);
  await updateSession(sessionId, {
    status,
    summary: status === "done" ? current?.summary || summary : summary,
  });
  if (status === "error") {
    await pushMessage(sessionId, { id: randomUUID(), role: "log", text: summary });
    events.onLog(sessionId, summary);
  }
  events.onStatus(sessionId);
}

async function ensureProcess(sessionId: string, events: RunnerEvents): Promise<void> {
  const entry = live.get(sessionId);
  if (!entry) return;
  if (entry.child && entry.ready) {
    await entry.ready;
    return;
  }
  const launch = resolveAgentLaunch(["--trust", "acp"]);
  const child = spawn(launch.command, launch.args, {
    cwd: entry.cwd,
    env: launch.env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  entry.child = child;
  entry.buffer = "";
  entry.acpId = undefined;
  const ready = new Promise<void>((resolve, reject) => {
    const fail = (error: Error) => {
      rejectPending(sessionId, error);
      reject(error);
    };
    child.on("error", (error) => {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      fail(new Error(missing ? "找不到命令 agent。先在这台电脑上安装并登录 Cursor CLI。" : error.message));
    });
    child.on("close", (code) => {
      entry.child = null;
      entry.ready = null;
      entry.acpId = undefined;
      fail(new Error(code === 0 ? "Cursor 已退出" : `Cursor 退出码 ${code ?? 1}`));
    });
    child.stdout.on("data", (chunk: Buffer) => {
      entry.buffer += chunk.toString();
      const lines = entry.buffer.split("\n");
      entry.buffer = lines.pop() ?? "";
      for (const line of lines) void handleLine(sessionId, line, events);
    });
    child.stderr.on("data", () => {
      // ACP debug noise stays off the phone. A real failure arrives as an RPC error or exit code.
    });
    resolve();
  });
  entry.ready = ready.catch((error: Error) => {
    throw error;
  });
  try {
    await request(entry, "initialize", {
      protocolVersion: 1,
      clientInfo: { name: "agentsmaster", version: "0.1.0" },
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        _meta: { parameterizedModelPicker: true },
      },
    });
  } catch (error) {
    child.kill();
    entry.child = null;
    entry.ready = null;
    throw error;
  }
}

async function openAcpSession(entry: LiveCursor, externalId?: string): Promise<string> {
  const cwd = path.resolve(entry.cwd);
  if (externalId) {
    try {
      await request(entry, "session/load", { sessionId: externalId, cwd, mcpServers: [] });
      return externalId;
    } catch {
      // Older print-mode ids, or a missing chat, start a fresh ACP session.
    }
  }
  const created = (await request(entry, "session/new", { cwd, mcpServers: [] })) as { sessionId?: string };
  if (!created.sessionId) throw new Error("Cursor 没有返回会话编号");
  return created.sessionId;
}

function handleLine(sessionId: string, line: string, events: RunnerEvents): void {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return;
  let message: RpcMessage;
  try {
    message = JSON.parse(trimmed) as RpcMessage;
  } catch {
    return;
  }
  const entry = live.get(sessionId);
  if (!entry) return;
  if (message.method && message.id != null) {
    void answerRequest(sessionId, message, events);
    return;
  }
  if (message.method === "session/update") {
    takeUpdate(sessionId, message.params, events);
    return;
  }
  if (message.id == null || typeof message.id !== "number") return;
  const pending = entry.pending.get(message.id);
  if (!pending) return;
  entry.pending.delete(message.id);
  if (message.error) {
    pending.reject(new Error(rpcError(message.error)));
    return;
  }
  pending.resolve(message.result);
}

async function answerRequest(sessionId: string, message: RpcMessage, events: RunnerEvents): Promise<void> {
  const entry = live.get(sessionId);
  if (!entry?.child) return;
  if (message.method !== "session/request_permission") {
    write(entry, {
      jsonrpc: "2.0",
      id: message.id,
      error: { code: -32601, message: "Method not found" },
    });
    return;
  }
  const params = (message.params ?? {}) as {
    toolCall?: { title?: string; kind?: string; content?: unknown };
    options?: Array<{ optionId?: string; name?: string; kind?: string }>;
  };
  const requestId = String(message.id);
  const title = params.toolCall?.title?.trim() || "这项操作";
  const changes = changesFrom(params.toolCall?.content);
  const detail = detailFrom(params.toolCall?.content).slice(0, 1200);
  const options = (params.options ?? [])
    .filter((option) => option.optionId)
    .map((option) => ({
      id: option.optionId as string,
      name: choiceName(option.kind, option.name),
      kind: option.kind || "",
    }));
  const ask = { requestId, title, detail, options, changes, deadline: Date.now() + permissionWaitMs };
  const chooser = options.filter((option) => option.kind === "allow_once").length > 1;
  if (getSession(sessionId)?.cursorAutoApprove && !chooser) {
    const allow = options.find((option) => option.kind === "allow_always") ?? options.find((option) => option.kind === "allow_once");
    if (allow) {
      write(entry, {
        jsonrpc: "2.0",
        id: message.id,
        result: { outcome: { outcome: "selected", optionId: allow.id } },
      });
      return;
    }
  }
  events.onPermission?.(sessionId, ask);
  try {
    const optionId = await waitPermission(sessionId, requestId, ask);
    write(entry, {
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "selected", optionId } },
    });
  } catch {
    write(entry, {
      jsonrpc: "2.0",
      id: message.id,
      result: { outcome: { outcome: "cancelled" } },
    });
  }
}

function waitPermission(sessionId: string, requestId: string, ask: PermissionAsk): Promise<string> {
  const key = permissionKey(sessionId, requestId);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiter = permissions.get(key);
      if (!waiter) return;
      permissions.delete(key);
      const rejectOption = ask.options.find((option) => option.kind.startsWith("reject"));
      if (rejectOption) waiter.resolve(rejectOption.id);
      else waiter.reject(new Error("确认超时"));
    }, permissionWaitMs);
    permissions.set(key, { resolve, reject, ask, timer });
  });
}

function takeUpdate(sessionId: string, params: unknown, events: RunnerEvents): void {
  if (!params || typeof params !== "object") return;
  const update = (params as { update?: Record<string, unknown> }).update;
  if (!update) return;
  const kind = update.sessionUpdate;
  if (kind === "agent_message_chunk") {
    const text = plainCursorError(textFrom(update.content));
    if (!text) return;
    events.onDelta(sessionId, text);
    void appendAgentText(sessionId, text);
    return;
  }
  if (kind === "tool_call") {
    const raw = typeof update.title === "string" ? update.title : "工具";
    const title = raw.startsWith("正在") ? raw : `正在执行 ${raw}`;
    events.onTool(sessionId, "start", title);
    void pushMessage(sessionId, { id: randomUUID(), role: "tool", text: title });
  }
}

function request(entry: LiveCursor, method: string, params: unknown): Promise<unknown> {
  const id = entry.nextId++;
  const promise = new Promise((resolve, reject) => {
    entry.pending.set(id, { resolve, reject });
  });
  write(entry, { jsonrpc: "2.0", id, method, params });
  return promise;
}

function write(entry: LiveCursor, message: unknown): void {
  entry.child?.stdin.write(`${JSON.stringify(message)}\n`);
}

function notify(entry: LiveCursor, method: string, params: unknown): void {
  write(entry, { jsonrpc: "2.0", method, params });
}

function rejectPending(sessionId: string, error: Error): void {
  const entry = live.get(sessionId);
  if (entry) {
    for (const pending of entry.pending.values()) pending.reject(error);
    entry.pending.clear();
  }
  for (const [key, waiter] of permissions) {
    if (!key.startsWith(`${sessionId}:`)) continue;
    clearTimeout(waiter.timer);
    permissions.delete(key);
    waiter.reject(error);
  }
}

function permissionKey(sessionId: string, requestId: string): string {
  return `${sessionId}:${requestId}`;
}

function changesFrom(content: unknown): PermissionChange[] {
  if (!Array.isArray(content)) return [];
  const changes: PermissionChange[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; path?: string; oldText?: string; newText?: string };
    if (record.type !== "diff" || !record.path) continue;
    const diff = lineDiff(record.oldText ?? "", record.newText ?? "");
    changes.push({
      path: record.path,
      summary: diff.split("\n").slice(0, 6).join("\n"),
      diff,
    });
  }
  return changes;
}

function lineDiff(oldText: string, newText: string): string {
  const oldLines = oldText.split("\n");
  const newLines = newText.split("\n");
  if (oldLines.length + newLines.length > 500) {
    const delta = newLines.length - oldLines.length;
    const direction = delta > 0 ? `多 ${delta} 行` : delta < 0 ? `少 ${-delta} 行` : "行数不变";
    return `约 ${newLines.length} 行，相对原来${direction}`;
  }
  const lines: string[] = [];
  const count = Math.max(oldLines.length, newLines.length);
  for (let index = 0; index < count && lines.length < 80; index += 1) {
    if (oldLines[index] === newLines[index]) continue;
    if (oldLines[index] !== undefined) lines.push(`- ${oldLines[index]}`);
    if (newLines[index] !== undefined && lines.length < 80) lines.push(`+ ${newLines[index]}`);
  }
  return lines.join("\n") || "内容有调整";
}

function detailFrom(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as { type?: string; path?: string; content?: { text?: string }; newText?: string };
    if (record.type === "content" && record.content?.text) parts.push(record.content.text);
  }
  return parts.join("\n").trim();
}

function textFrom(content: unknown): string {
  if (!content || typeof content !== "object") return "";
  const record = content as { type?: string; text?: string };
  return record.type === "text" ? record.text ?? "" : "";
}

function plainCursorError(text: string): string {
  const raw = text.trim();
  if (!raw) return text;
  if (/unavailable|retriableerror|model provider|error_openai|connecterror/i.test(raw)) {
    return "连不上 Cursor 的模型服务，多半是暂时的。过一会儿在这个会话里发「继续」。";
  }
  if (/user rejected/i.test(raw)) return "这次操作没有被允许。";
  if (/not authenticated|authentication required/i.test(raw)) return "Cursor 还没登录。在这台电脑上先运行 agent login。";
  return text;
}

function choiceName(kind: string | undefined, fallback: string | undefined): string {
  if (kind === "allow_once") return "允许一次";
  if (kind === "allow_always") return "总是允许";
  if (kind === "reject_once") return "拒绝";
  if (kind === "reject_always") return "总是拒绝";
  return fallback || "确认";
}

function rpcError(error: { message?: string; data?: unknown }): string {
  if (typeof error.data === "string" && error.data.trim()) return error.data;
  if (error.data && typeof error.data === "object" && "message" in error.data) {
    const message = (error.data as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message;
  }
  return plainCursorError(error.message || "Cursor 请求失败");
}

function chosenModel(sessionId: string): string {
  const session = getSession(sessionId);
  if (!session) return "";
  if (session.cursorModel !== undefined) return session.cursorModel;
  return getAgent(session.agentId)?.model?.trim() || "";
}

function promptBlocks(text: string, images: ImagePayload[]) {
  const blocks: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [];
  if (text) blocks.push({ type: "text", text });
  for (const image of images) {
    if (!image.data) continue;
    blocks.push({ type: "image", data: image.data, mimeType: image.mediaType || "image/png" });
  }
  if (!blocks.length) blocks.push({ type: "text", text: "" });
  return blocks;
}

async function alignCursor(entry: LiveCursor, sessionId: string, events: RunnerEvents): Promise<void> {
  await ensureCatalog(entry);
  const session = getSession(sessionId);
  const picked = resolveSelection(sessionId, entry.catalog ?? []);
  if (picked.model && entry.acpId && entry.appliedModel !== picked.model) {
    try {
      await request(entry, "session/set_config_option", {
        sessionId: entry.acpId,
        configId: "model",
        value: picked.model,
      });
      entry.appliedModel = picked.model;
    } catch {
      events.onLog(sessionId, "模型暂时没切过去，先用当前模型继续。");
    }
  }
  const spec = entry.catalog?.find((item) => item.id === picked.model);
  const effortKey = `${picked.model}:${picked.effort}`;
  if (spec?.effort && picked.effort && entry.acpId && entry.appliedEffort !== effortKey) {
    try {
      await request(entry, "session/set_config_option", {
        sessionId: entry.acpId,
        configId: spec.effort.id,
        value: picked.effort,
      });
      entry.appliedEffort = effortKey;
    } catch {
      events.onLog(sessionId, "High 这一档暂时没切过去。");
    }
  }
  const fastKey = `${picked.model}:${picked.fast}`;
  if (spec?.fast && picked.fast !== undefined && entry.acpId && entry.appliedFastKey !== fastKey) {
    try {
      await request(entry, "session/set_config_option", {
        sessionId: entry.acpId,
        configId: spec.fast.id,
        value: picked.fast ? spec.fast.on : spec.fast.off,
      });
      entry.appliedFastKey = fastKey;
    } catch {
      events.onLog(sessionId, "Fast 暂时没切过去。");
    }
  } else if (!spec?.fast && session?.cursorFast !== undefined && entry.fastOption && entry.acpId && entry.appliedFastKey !== fastKey) {
    try {
      await request(entry, "session/set_config_option", {
        sessionId: entry.acpId,
        configId: entry.fastOption.id,
        value: session.cursorFast ? entry.fastOption.on : entry.fastOption.off,
      });
      entry.appliedFastKey = fastKey;
    } catch {
      events.onLog(sessionId, "Fast 暂时没切过去。");
    }
  }
  await announceCursorSetting(sessionId, events);
}

async function ensureCatalog(entry: LiveCursor): Promise<void> {
  if (entry.catalog?.length) return;
  if (!entry.catalogLoading) {
    entry.catalogLoading = (async () => {
      try {
        const result = (await request(entry, "cursor/list_available_models", {})) as {
          models?: Array<{ value?: string; name?: string; configOptions?: CatalogOption[] }>;
        };
        const catalog = readCatalog(result.models ?? []);
        if (catalog.length) {
          entry.catalog = catalog;
          entry.fastOption = findFast(result.models ?? []);
          catalogCache = { at: Date.now(), models: catalog };
          return;
        }
      } catch {
        // Older CLIs only expose `agent models`.
      }
      entry.catalog = await loadCursorCatalog();
    })();
  }
  await entry.catalogLoading;
}

async function loadCursorCatalog(): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < 5 * 60_000) return catalogCache.models;
  const models = await fetchCatalog();
  if (models.length) catalogCache = { at: Date.now(), models };
  return models;
}

function fetchCatalog(): Promise<CatalogModel[]> {
  return new Promise((resolve) => {
    const launch = resolveAgentLaunch(["--trust", "acp"]);
    const child = spawn(launch.command, launch.args, { env: launch.env, stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "";
    let next = 1;
    let settled = false;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    const finish = (models: CatalogModel[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(models);
    };
    const timer = setTimeout(() => finish([]), 15000);
    const send = (method: string, params: unknown) => {
      const id = next++;
      const promise = new Promise((resolveSend, rejectSend) => pending.set(id, { resolve: resolveSend, reject: rejectSend }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return promise;
    };
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim().startsWith("{")) continue;
        let message: RpcMessage;
        try {
          message = JSON.parse(line) as RpcMessage;
        } catch {
          continue;
        }
        if (typeof message.id !== "number") continue;
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || "rpc"));
        else waiter.resolve(message.result);
      }
    });
    child.on("error", () => finish([]));
    void (async () => {
      try {
        await send("initialize", {
          protocolVersion: 1,
          clientInfo: { name: "agentsmaster", version: "0.1.0" },
          clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { parameterizedModelPicker: true } },
        });
        const result = (await send("cursor/list_available_models", {})) as {
          models?: Array<{ value?: string; name?: string; configOptions?: CatalogOption[] }>;
        };
        finish(readCatalog(result.models ?? []));
      } catch {
        finish([]);
      }
    })();
  });
}

async function cursorSetting(sessionId: string) {
  const session = getSession(sessionId);
  if (!session || session.runner !== "cursor") return null;
  const entry = live.get(sessionId);
  if (entry) await ensureCatalog(entry);
  const catalog = entry?.catalog?.length ? entry.catalog : await loadCursorCatalog();
  if (catalog.length) {
    const models = expandChoices(catalog);
    const model = currentVariantId(sessionId, catalog, models);
    return { model, models, fast: decodeVariant(model)?.fast === true, fastAvailable: false };
  }
  const models = entry?.models.length ? entry.models : await listCursorModels();
  const model = chosenModel(sessionId);
  return {
    model,
    models: !model || models.some((item) => item.id === model) ? models : [{ id: model, name: model }, ...models],
    fast: session.cursorFast === true,
    fastAvailable: Boolean(entry?.fastOption),
  };
}

function readCatalog(models: Array<{ value?: string; name?: string; configOptions?: CatalogOption[] }>): CatalogModel[] {
  return models
    .filter((model) => model.value)
    .map((model) => {
      const options = model.configOptions ?? [];
      const effort = options.find((option) => /effort|reasoning/i.test(`${option.id ?? ""} ${option.name ?? ""}`));
      const fast = options.find((option) => /fast/i.test(`${option.id ?? ""} ${option.name ?? ""}`));
      const values = (effort?.options ?? [])
        .filter((option) => option.value)
        .map((option) => ({ value: String(option.value), name: cleanLabel(option.name || String(option.value)) }));
      return {
        id: model.value as string,
        name: cleanLabel(model.name || (model.value as string)),
        effort: effort?.id && values.length ? { id: effort.id, values } : undefined,
        fast: fast?.id ? readFast(fast) : undefined,
      };
    });
}

function readFast(option: CatalogOption): FastOption | undefined {
  if (!option.id) return undefined;
  const values = (option.options ?? []).map((item) => String(item.value ?? "")).filter(Boolean);
  const on = values.find((value) => /^(1|true|on|yes|fast)$/i.test(value));
  const off = values.find((value) => /^(0|false|off|no)$/i.test(value));
  if (!on || !off || on === off) return undefined;
  return { id: option.id, on, off };
}

function expandChoices(catalog: CatalogModel[]): CursorModelChoice[] {
  const choices: CursorModelChoice[] = [];
  for (const model of catalog) {
    const efforts = model.effort?.values.length ? model.effort.values : [{ value: "", name: "" }];
    const fasts = model.fast ? [false, true] : [false];
    for (const effort of efforts) {
      for (const fast of fasts) {
        choices.push({
          id: encodeVariant({ model: model.id, effort: effort.value, fast }),
          name: [model.name, effort.name, fast ? "Fast" : ""].filter(Boolean).join(" "),
        });
      }
    }
  }
  return choices;
}

function encodeVariant(variant: Variant): string {
  return ["v1", variant.model, variant.effort, variant.fast ? "1" : "0"].join("\u001f");
}

function decodeVariant(id: string): Variant | null {
  const parts = id.split("\u001f");
  if (parts[0] !== "v1" || parts.length !== 4 || !parts[1]) return null;
  return { model: parts[1], effort: parts[2] || "", fast: parts[3] === "1" };
}

function resolveSelection(sessionId: string, catalog: CatalogModel[]): { model: string; effort: string; fast: boolean | undefined } {
  const session = getSession(sessionId);
  const stored = chosenModel(sessionId);
  const decoded = decodeVariant(stored);
  const legacy = decoded ? null : matchLegacy(stored, catalog);
  const model = decoded?.model || legacy?.model || stored;
  const effort = session?.cursorEffort ?? decoded?.effort ?? legacy?.effort ?? "";
  const fast = session?.cursorFast !== undefined ? session.cursorFast : decoded?.fast ?? legacy?.fast;
  return { model, effort, fast };
}

function currentVariantId(sessionId: string, catalog: CatalogModel[], choices: CursorModelChoice[]): string {
  const picked = resolveSelection(sessionId, catalog);
  const id = encodeVariant({ model: picked.model, effort: picked.effort, fast: picked.fast === true });
  if (choices.some((item) => item.id === id)) return id;
  const sameModel = choices.find((item) => decodeVariant(item.id)?.model === picked.model);
  return sameModel?.id || picked.model;
}

function matchLegacy(id: string, catalog: CatalogModel[]): Variant | null {
  if (!id || catalog.some((model) => model.id === id)) return null;
  let fast = false;
  let rest = id;
  if (rest.endsWith("-fast")) {
    fast = true;
    rest = rest.slice(0, -5);
  }
  const effort = ["xhigh", "medium", "high", "low", "max"].find((item) => rest.endsWith(`-${item}`)) || "";
  const base = effort ? rest.slice(0, -(effort.length + 1)) : rest;
  const known = catalog.find((model) => model.id === base);
  if (!known) return null;
  const effortValue = known.effort?.values.some((item) => item.value === effort) ? effort : "";
  return { model: known.id, effort: effortValue, fast: Boolean(known.fast) && fast };
}

function cleanLabel(value: string): string {
  return value.replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
}

function findFast(models: Array<{ configOptions?: CatalogOption[] }>): FastOption | undefined {
  for (const model of models) {
    for (const option of model.configOptions ?? []) {
      const label = `${option.id ?? ""} ${option.name ?? ""}`.toLowerCase();
      if (!label.includes("fast") || !option.id) continue;
      const values = (option.options ?? []).map((item) => String(item.value ?? "")).filter(Boolean);
      const on = values.find((value) => /^(1|true|on|yes|fast)$/i.test(value));
      const off = values.find((value) => /^(0|false|off|no)$/i.test(value));
      if (on && off && on !== off) return { id: option.id, on, off };
    }
  }
  return undefined;
}

