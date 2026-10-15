import type { Room } from "../shared/protocol.js";
import type { StoredRoom } from "./store.js";

export function resolveMention(
  token: string,
  members: { projectId: string; name: string; role: string }[],
): { projectId: string; name: string; role: string } | undefined {
  const byName = members.filter((member) => member.name === token);
  if (byName.length === 1) return byName[0];
  const byRole = members.filter((member) => member.role === token);
  if (byRole.length === 1) return byRole[0];
  return undefined;
}

export function readMentions(
  text: string,
  members: { projectId: string; name: string; role: string }[],
): { targets: { projectId: string; name: string; role: string }[]; missing: string[] } {
  const targets: { projectId: string; name: string; role: string }[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(/@([^\s@]+)/g)) {
    const token = match[1];
    const hit = resolveMention(token, members);
    if (!hit) {
      if (!missing.includes(token)) missing.push(token);
      continue;
    }
    if (seen.has(hit.projectId)) continue;
    seen.add(hit.projectId);
    targets.push(hit);
  }
  return { targets, missing };
}

export function parseDispatch(text: string): { name: string; task: string } | null {
  const match = text.trim().match(/派给[:：]\s*(.+)\r?\n任务[:：]\s*([\s\S]+)$/);
  if (!match) return null;
  const name = match[1].trim();
  const task = match[2].trim();
  if (!name || !task) return null;
  return { name, task };
}

export function roomBrief(room: Pick<Room, "name" | "rules"> & { maxRounds?: number; round?: number }, members: { name: string; role: string }[]): string {
  const lines = members.length > 0 ? members.map((member) => `- ${member.name}（${member.role}）`).join("\n") : "（还没有人入座）";
  return [
    `你是会议室「${room.name}」的主持。你自己不改文件，只按规则组织这场会议。`,
    "规则：",
    room.rules.trim() || "（还没有规则）",
    "与会者和职责：",
    lines,
    "要派一个与会者干活时，回复的最后两行必须是：",
    "派给: 与会者名字",
    "任务: 要做的事",
    "按上面的职责决定派谁，名字用与会者名字。这轮不派人，就不要写「派给」。",
    `最多派活 ${Math.max(1, room.maxRounds ?? 200)} 轮，已经用了 ${Math.max(0, room.round ?? 0)} 轮。到了上限就结束，不要再写「派给」。`,
  ].join("\n");
}

export function roomModelText(room: Pick<Room, "name" | "rules"> & { maxRounds?: number; round?: number }, members: { name: string; role: string }[], body: string): string {
  return `${roomBrief(room, members)}\n\n${body.trim()}`;
}

export type RoomPlan =
  | { type: "dispatch"; roomId: string; projectId: string; task: string }
  | { type: "report"; roomId: string; projectId: string; projectName: string; hostSessionId: string; status: "done" | "error"; summary: string; detail: string }
  | { type: "skip"; roomId: string; text: string }
  | { type: "none" };

export function planRoom(input: {
  sessionId: string;
  status: "done" | "error";
  summary: string;
  agentText: string;
  rooms: StoredRoom[];
  projects: { id: string; name: string }[];
}): RoomPlan {
  for (const room of input.rooms) {
    const job = room.jobs.find((item) => item.sessionId === input.sessionId);
    if (!job) continue;
    const project = input.projects.find((item) => item.id === job.projectId);
    return {
      type: "report",
      roomId: room.id,
      projectId: job.projectId,
      projectName: project?.name || "成员",
      hostSessionId: job.hostSessionId || room.sessionId,
      status: input.status,
      summary: input.summary.trim() || (input.status === "error" ? "失败了" : "做完了"),
      detail: input.agentText.trim().slice(0, 2000) || input.summary.trim() || "没有文字结果",
    };
  }

  const room = input.rooms.find((item) => item.sessionId === input.sessionId);
  if (!room || input.status !== "done") return { type: "none" };
  const parsed = parseDispatch(input.agentText);
  if (!parsed) return { type: "none" };
  const joined = input.projects.filter((item) => room.members.some((member) => member.projectId === item.id));
  const byName = joined.find((item) => item.name === parsed.name || item.id === parsed.name);
  const byRole = room.members.filter((member) => member.role === parsed.name);
  const project = byName || (byRole.length === 1 ? joined.find((item) => item.id === byRole[0]?.projectId) : undefined);
  if (!project) return { type: "skip", roomId: room.id, text: `会上没有叫「${parsed.name}」的人` };
  return { type: "dispatch", roomId: room.id, projectId: project.id, task: parsed.task };
}
