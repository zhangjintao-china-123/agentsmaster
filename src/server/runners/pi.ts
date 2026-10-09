import { randomUUID } from "node:crypto";
import type { ImagePayload, PermissionChange, PermissionOption, RunnerId } from "../../shared/protocol.js";
import { loadDeepseekLlm } from "../llm.js";
import { appendAgentText, getSession, pushMessage, updateSession } from "../store.js";
import { computerUseTools } from "./computer-use.js";
import { promptWithImages, saveImages } from "./images.js";

export type RunnerEvents = {
  onDelta: (sessionId: string, text: string) => void;
  onTool: (sessionId: string, phase: "start" | "end", name: string) => void;
  onLog: (sessionId: string, text: string) => void;
  onStatus: (sessionId: string) => void;
  onPermission?: (
    sessionId: string,
    ask: {
      requestId: string;
      title: string;
      detail: string;
      options: PermissionOption[];
      changes: PermissionChange[];
      deadline: number;
    },
  ) => void;
  onCursorSetting?: (
    sessionId: string,
    setting: {
      model: string;
      models: { id: string; name: string }[];
      fast: boolean;
      fastAvailable: boolean;
    },
  ) => void;
};

type PiSession = {
  abort: () => Promise<void>;
  prompt: (
    text: string,
    options?: {
      images?: Array<{
        type: "image";
        source: { type: "base64"; mediaType: string; data: string };
      }>;
    },
  ) => Promise<void>;
  followUp: (text: string) => Promise<void>;
  subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => () => void;
  sessionFile?: string;
  agent: { state: { errorMessage?: string } };
};

const live = new Map<string, { running: boolean; session: PiSession }>();

export async function runPiPrompt(options: {
  sessionId: string;
  cwd: string;
  text: string;
  images?: ImagePayload[];
  events: RunnerEvents;
}): Promise<void> {
  const record = getSession(options.sessionId);
  if (!record || record.runner !== "pi") return;

  const entry = await ensurePi(options.sessionId, options.cwd, options.events);
  const userText = options.text.trim();
  await pushMessage(options.sessionId, {
    id: randomUUID(),
    role: "user",
    text: userText,
  });
  await updateSession(options.sessionId, { status: "working", summary: "正在思考" });
  options.events.onStatus(options.sessionId);

  const images = (options.images ?? []).map((image) => ({
    type: "image" as const,
    source: {
      type: "base64" as const,
      mediaType: image.mediaType,
      data: image.data,
    },
  }));

  try {
    if (entry.running) {
      const paths = await saveImages(options.images);
      await entry.session.followUp(promptWithImages(userText, paths));
    } else {
      entry.running = true;
      await entry.session.prompt(userText, images.length ? { images } : undefined);
    }
  } catch (error) {
    entry.running = false;
    const message = error instanceof Error ? error.message : "Pi 运行失败";
    await pushMessage(options.sessionId, {
      id: randomUUID(),
      role: "log",
      text: message,
    });
    await updateSession(options.sessionId, { status: "error", summary: message });
    options.events.onLog(options.sessionId, message);
    options.events.onStatus(options.sessionId);
  }
}

async function ensurePi(sessionId: string, cwd: string, events: RunnerEvents) {
  const existing = live.get(sessionId);
  if (existing) return existing;

  const pi = await import("@earendil-works/pi-coding-agent");
  const record = getSession(sessionId);
  const sessionManager = record?.piSessionFile
    ? pi.SessionManager.open(record.piSessionFile)
    : pi.SessionManager.create(cwd);
  const llm = loadDeepseekLlm();
  const modelRuntime = await pi.ModelRuntime.create();
  await modelRuntime.setRuntimeApiKey("deepseek", llm.apiKey);
  const model = modelRuntime.getModel("deepseek", llm.model);
  if (!model) throw new Error("Pi 没有 deepseek-flash");
  const { session } = await pi.createAgentSession({
    cwd,
    sessionManager,
    modelRuntime,
    model,
    thinkingLevel: "off",
    customTools: computerUseTools(),
  });

  const typed = session as PiSession;
  const entry = { running: false, session: typed };
  typed.subscribe((event) => {
    void handlePiEvent(sessionId, entry, event, events);
  });
  if (typed.sessionFile) {
    await updateSession(sessionId, { piSessionFile: typed.sessionFile });
  }
  live.set(sessionId, entry);
  return entry;
}

async function handlePiEvent(
  sessionId: string,
  entry: { running: boolean; session: PiSession },
  event: { type: string; [key: string]: unknown },
  events: RunnerEvents,
): Promise<void> {
  if (event.type === "agent_start") {
    entry.running = true;
    await updateSession(sessionId, { status: "working" });
    events.onStatus(sessionId);
    return;
  }

  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent as { type?: string; delta?: string } | undefined;
    if (inner?.type === "text_delta" && inner.delta) {
      await appendAgentText(sessionId, inner.delta);
      events.onDelta(sessionId, inner.delta);
    }
    return;
  }

  if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
    const name = String(event.toolName ?? "tool");
    const phase = event.type === "tool_execution_start" ? "start" : "end";
    if (phase === "start") {
      await pushMessage(sessionId, {
        id: randomUUID(),
        role: "tool",
        text: name,
      });
    }
    events.onTool(sessionId, phase, name);
    return;
  }

  if (event.type === "agent_end") {
    entry.running = false;
    const errorMessage = entry.session.agent.state.errorMessage;
    await updateSession(sessionId, {
      status: errorMessage ? "error" : "done",
      summary: errorMessage || getSession(sessionId)?.summary || "完成",
    });
    events.onStatus(sessionId);
  }
}

export function cancelPi(sessionId: string): boolean {
  const entry = live.get(sessionId);
  if (!entry?.running) return false;
  void entry.session.abort();
  return true;
}

export function isPiRunner(runner: RunnerId): runner is "pi" {
  return runner === "pi";
}
