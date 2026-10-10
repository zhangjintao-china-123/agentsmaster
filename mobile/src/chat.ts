import type { ChatMessage, RunnerId } from "../../src/shared/protocol";

export const runnerLabel: Record<RunnerId, string> = {
  pi: "Pi",
  cursor: "Cursor",
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
};

export function appendDelta(current: ChatMessage[], text: string): ChatMessage[] {
  const last = current.at(-1);
  if (last?.role === "agent") {
    return current.map((item, index) => (index === current.length - 1 ? { ...item, text: item.text + text } : item));
  }
  return [...current, { id: uid(), role: "agent", text, at: Date.now() }];
}

export type FoldedMessage = ChatMessage & { kind: "message"; count: number };
export type TraceLine = { text: string; at?: number };
export type FoldedTrace = { kind: "trace"; id: string; lines: TraceLine[] };
export type FoldedItem = FoldedMessage | FoldedTrace;

export function foldTools(messages: ChatMessage[]): FoldedItem[] {
  const folded: FoldedItem[] = [];
  for (const message of messages) {
    if (message.role === "tool" && /^(started|completed|tool)$/i.test(message.text)) continue;
    if (message.role === "tool" || message.role === "log") {
      const last = folded.at(-1);
      const line = { text: message.text, at: message.at };
      if (last?.kind === "trace") {
        last.lines.push(line);
        continue;
      }
      folded.push({ kind: "trace", id: message.id, lines: [line] });
      continue;
    }
    folded.push({ ...message, kind: "message", count: 1 });
  }
  return folded;
}

export function formatTime(ts: number) {
  const date = new Date(ts);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

export function messageTime(ts?: number) {
  if (!ts) return "";
  const date = new Date(ts);
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

export function uid() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
