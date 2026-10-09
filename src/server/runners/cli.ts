import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { ImagePayload, RunnerId } from "../../shared/protocol.js";
import {
  appendAgentText,
  getSession,
  pushMessage,
  updateSession,
} from "../store.js";
import { runCursorPrompt } from "./cursor-acp.js";
import type { RunnerEvents } from "./pi.js";
import { promptWithImages, saveImages } from "./images.js";

type CliRunner = Exclude<RunnerId, "pi">;

type LiveCli = {
  child: ChildProcessWithoutNullStreams | null;
  queue: string[];
  running: boolean;
};

const live = new Map<string, LiveCli>();

const bins: Record<CliRunner, string> = {
  cursor: "agent",
  opencode: "opencode",
  claude: "claude",
  codex: "codex",
};

export async function runCliPrompt(options: {
  sessionId: string;
  cwd: string;
  runner: CliRunner;
  text: string;
  images?: ImagePayload[];
  events: RunnerEvents;
}): Promise<void> {
  if (options.runner === "cursor") return runCursorPrompt(options);
  const record = getSession(options.sessionId);
  if (!record) return;
  const paths = await saveImages(options.images);
  const text = promptWithImages(options.text.trim(), paths);
  await pushMessage(options.sessionId, {
    id: randomUUID(),
    role: "user",
    text: options.text.trim(),
  });

  const entry = live.get(options.sessionId) ?? { child: null, queue: [], running: false };
  live.set(options.sessionId, entry);

  if (entry.running && entry.child && entry.child.stdin.writable) {
    entry.child.stdin.write(`${text}\n`);
    return;
  }
  if (entry.running) {
    entry.queue.push(text);
    return;
  }
  await launch(options.sessionId, options.cwd, options.runner, text, record.externalId, options.events);
}

async function launch(
  sessionId: string,
  cwd: string,
  runner: CliRunner,
  text: string,
  externalId: string | undefined,
  events: RunnerEvents,
): Promise<void> {
  const entry = live.get(sessionId);
  if (!entry) return;
  const args = buildArgs(runner, text, externalId);
  const child = spawn(bins[runner], args, { cwd, env: process.env });
  entry.child = child;
  entry.running = true;

  let buffer = "";
  const consume = (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      void takeLine(sessionId, runner, line, events);
    }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk: Buffer) => {
    const text = chunk.toString().trim();
    if (text) events.onLog(sessionId, text);
  });

  child.on("error", (error) => {
    const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
    const message = missing
      ? `找不到命令 ${bins[runner]}。先在这台电脑上安装并登录。`
      : error.message;
    void finish(sessionId, "error", message, events);
  });

  child.on("close", (code) => {
    if (buffer.trim()) void takeLine(sessionId, runner, buffer, events);
    buffer = "";
    entry.child = null;
    entry.running = false;
    const next = entry.queue.shift();
    if (next) {
      const latest = getSession(sessionId);
      void launch(sessionId, cwd, runner, next, latest?.externalId, events);
      return;
    }
    void finish(
      sessionId,
      code === 0 ? "done" : "error",
      code === 0 ? "完成" : `退出码 ${code ?? 1}`,
      events,
    );
  });

  await updateSession(sessionId, { status: "working", summary: "正在运行" });
  events.onStatus(sessionId);
}

async function finish(
  sessionId: string,
  status: "done" | "error",
  summary: string,
  events: RunnerEvents,
): Promise<void> {
  const current = getSession(sessionId);
  if (!current || current.status === "working") {
    await updateSession(sessionId, {
      status,
      summary: status === "done" ? current?.summary || summary : summary,
    });
  }
  if (status === "error") {
    await pushMessage(sessionId, { id: randomUUID(), role: "log", text: summary });
    events.onLog(sessionId, summary);
  }
  events.onStatus(sessionId);
}

async function takeLine(
  sessionId: string,
  runner: CliRunner,
  line: string,
  events: RunnerEvents,
): Promise<void> {
  const trimmed = line.trim();
  if (!trimmed) return;
  const parsed = runner === "cursor" ? parseCursorLine(trimmed) : parseLine(trimmed);
  if (parsed.externalId) {
    await updateSession(sessionId, { externalId: parsed.externalId });
  }
  if (parsed.tool) {
    await pushMessage(sessionId, { id: randomUUID(), role: "tool", text: parsed.tool });
    events.onTool(sessionId, "start", parsed.tool);
    return;
  }
  const text = parsed.text ?? (parsed.externalId ? "" : trimmed);
  if (!text) return;
  if (parsed.text) {
    events.onDelta(sessionId, parsed.text);
    void appendAgentText(sessionId, parsed.text);
  } else {
    events.onLog(sessionId, text);
    void pushMessage(sessionId, { id: randomUUID(), role: "log", text });
  }
  void runner;
}

function parseCursorLine(line: string): { text?: string; tool?: string; externalId?: string } {
  if (!line.startsWith("{")) return {};
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const externalId = typeof value.session_id === "string" ? value.session_id : undefined;
    if (value.type === "assistant") {
      const liveDelta = value.timestamp_ms != null && value.model_call_id == null;
      if (!liveDelta) return { externalId };
      return { text: textFromContent(value), externalId };
    }
    if (value.type === "tool_call") {
      if (value.subtype === "completed") return { externalId };
      return { tool: cursorToolName(value.tool_call), externalId };
    }
    return { externalId };
  } catch {
    return {};
  }
}

function cursorToolName(toolCall: unknown): string {
  if (!toolCall || typeof toolCall !== "object") return "tool";
  const record = toolCall as Record<string, unknown>;
  const named = stringField(record, ["name", "tool"]);
  if (named) return named;
  const key = Object.keys(record).find((item) => item.endsWith("ToolCall") || item.endsWith("Tool"));
  if (!key) return "tool";
  return key.replace(/ToolCall$|Tool$/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
}

function parseLine(line: string): { text?: string; tool?: string; externalId?: string } {
  if (!line.startsWith("{")) return {};
  try {
    const value = JSON.parse(line) as Record<string, unknown>;
    const externalId = stringField(value, ["session_id", "sessionId", "thread_id", "id"]);
    const tool = stringField(value, ["tool", "tool_name", "toolName"]);
    const text =
      stringField(value, ["delta", "text"]) ||
      textFromContent(value) ||
      "";
    return { text: text || undefined, tool, externalId };
  } catch {
    return {};
  }
}

function textFromContent(value: Record<string, unknown>): string {
  const message = value.message;
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object") return "";
      const record = part as { type?: string; text?: string };
      return record.type === "text" ? record.text ?? "" : "";
    })
    .join("");
}

function stringField(value: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const field = value[key];
    if (typeof field === "string" && field.trim()) return field;
  }
  return undefined;
}

function buildArgs(runner: CliRunner, text: string, externalId?: string): string[] {
  if (runner === "opencode") {
    return externalId
      ? ["run", "--format", "json", "--session", externalId, text]
      : ["run", "--format", "json", text];
  }
  if (runner === "claude") {
    return externalId
      ? ["-p", text, "--resume", externalId, "--output-format", "stream-json", "--verbose"]
      : ["-p", text, "--output-format", "stream-json", "--verbose"];
  }
  return externalId ? ["exec", "resume", externalId, text] : ["exec", text];
}
