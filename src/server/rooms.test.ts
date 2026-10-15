import assert from "node:assert/strict";
import test from "node:test";
import { parseDispatch, planRoom, readMentions } from "./rooms.js";
import type { StoredRoom } from "./store.js";

function room(patch: Partial<StoredRoom> = {}): StoredRoom {
  return {
    id: "room-1",
    name: "联调",
    rules: "做完就收工",
    members: [{ projectId: "office", role: "程序员" }],
    sessionId: "room-session",
    sessionIds: ["room-session"],
    maxRounds: 200,
    round: 0,
    sessionRounds: { "room-session": 0 },
    jobs: [],
    ...patch,
  };
}

test("an @ names a seated agent by name or by a unique role", () => {
  const members = [
    { projectId: "office", name: "office", role: "程序员" },
    { projectId: "sheet", name: "智能表格", role: "QA" },
  ];
  assert.deepEqual(readMentions("@程序员 看一下登录", members).targets.map((item) => item.projectId), ["office"]);
  assert.deepEqual(readMentions("@智能表格 对一下表格", members).targets.map((item) => item.name), ["智能表格"]);
  assert.deepEqual(readMentions("@没有的人", members).missing, ["没有的人"]);
  assert.equal(readMentions("先开会", members).targets.length, 0);
});

test("reads a dispatch written at the end of a reply", () => {
  const parsed = parseDispatch("先看规则。\n派给: office\n任务: 补上登录测试");
  assert.deepEqual(parsed, { name: "office", task: "补上登录测试" });
  assert.equal(parseDispatch("这轮不派人"), null);
});

test("sends a finished member back to the room and lets the room assign the next one", () => {
  const projects = [{ id: "office", name: "office" }, { id: "sheet", name: "智能表格" }];
  const report = planRoom({
    sessionId: "job-1",
    status: "done",
    summary: "测试过了",
    agentText: "登录测试已补上",
    rooms: [room({ jobs: [{ sessionId: "job-1", projectId: "office", wait: 1 }] })],
    projects,
  });
  assert.equal(report.type, "report");
  if (report.type !== "report") return;
  assert.equal(report.projectName, "office");

  const next = planRoom({
    sessionId: "room-session",
    status: "done",
    summary: "继续",
    agentText: "派给: 智能表格\n任务: 看一下测试",
    rooms: [room({ members: [{ projectId: "office", role: "程序员" }, { projectId: "sheet", role: "QA" }] })],
    projects,
  });
  assert.deepEqual(next, { type: "dispatch", roomId: "room-1", projectId: "sheet", task: "看一下测试" });

  const byRole = planRoom({
    sessionId: "room-session",
    status: "done",
    summary: "继续",
    agentText: "派给: QA\n任务: 看一下测试",
    rooms: [room({ members: [{ projectId: "office", role: "程序员" }, { projectId: "sheet", role: "QA" }] })],
    projects,
  });
  assert.equal(byRole.type, "dispatch");
  if (byRole.type === "dispatch") assert.equal(byRole.projectId, "sheet");
});

test("does not assign a project that was never added to the room", () => {
  const plan = planRoom({
    sessionId: "room-session",
    status: "done",
    summary: "",
    agentText: "派给: 别人\n任务: 改接口",
    rooms: [room()],
    projects: [{ id: "office", name: "office" }, { id: "other", name: "别人" }],
  });
  assert.equal(plan.type, "skip");
});
