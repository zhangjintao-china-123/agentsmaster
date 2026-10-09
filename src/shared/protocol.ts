export const RUNNERS = ["pi", "cursor", "opencode", "claude", "codex"] as const;

export const ADMIN_AGENT_ID = "pi-admin";

export type RunnerId = (typeof RUNNERS)[number];

export type ImagePayload = {
  mediaType: string;
  data: string;
};

export type Agent = {
  id: string;
  name: string;
  runner: RunnerId;
  model?: string;
};

export type Project = {
  id: string;
  name: string;
  path: string;
  agentId: string;
};

export type SessionStatus = "idle" | "working" | "done" | "error";

export type SessionInfo = {
  id: string;
  projectId: string | null;
  agentId: string;
  runner: RunnerId;
  title: string;
  status: SessionStatus;
  summary: string;
  createdAt: number;
};

export type ChatMessage = {
  id: string;
  role: "user" | "agent" | "tool" | "log";
  text: string;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  status: "todo" | "doing" | "done";
  sessionId?: string;
};

export type GitFile = {
  path: string;
  status: string;
};

export type PermissionOption = {
  id: string;
  name: string;
  kind: string;
};

export type PermissionChange = {
  path: string;
  summary: string;
  diff: string;
};

export type CursorModelChoice = {
  id: string;
  name: string;
};

export type ClientMessage =
  | { type: "add_project"; path: string; name?: string }
  | { type: "add_cwd" }
  | { type: "remove_project"; projectId: string }
  | { type: "open_project"; projectId: string }
  | { type: "start"; agentId: string; projectId?: string | null; text: string; images?: ImagePayload[] }
  | { type: "prompt"; sessionId: string; text: string; images?: ImagePayload[] }
  | { type: "open_session"; sessionId: string }
  | { type: "cancel"; sessionId: string }
  | { type: "cursor_setting"; sessionId: string; model?: string; fast?: boolean }
  | { type: "permission"; sessionId: string; requestId: string; optionId: string }
  | { type: "git_status"; projectId: string }
  | { type: "git_diff"; projectId: string; path?: string }
  | { type: "git_commit"; projectId: string; message: string }
  | { type: "add_task"; projectId: string; title: string }
  | { type: "start_task"; taskId: string; runner: RunnerId }
  | { type: "browser_watch"; on: boolean }
  | { type: "browser_control"; on: boolean }
  | { type: "browser_mobile"; on: boolean; width?: number; height?: number; scale?: number }
  | { type: "browser_nav"; url: string }
  | { type: "browser_switch"; targetId: string }
  | { type: "browser_input"; kind: "click"; x: number; y: number }
  | { type: "browser_input"; kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "browser_input"; kind: "type"; text: string }
  | { type: "browser_port"; port: number }
  | { type: "desktop_watch"; on: boolean }
  | { type: "desktop_input"; kind: "down" | "up"; x: number; y: number; button: "left" | "right" }
  | { type: "desktop_input"; kind: "move"; x: number; y: number }
  | { type: "desktop_input"; kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "desktop_input"; kind: "type"; text: string };

export type BrowserTab = {
  id: string;
  title: string;
  url: string;
};

export type ServerMessage =
  | { type: "ready"; cwd: string }
  | { type: "catalog"; projects: Project[]; agents: Agent[]; sessions: SessionInfo[] }
  | { type: "project"; project: Project; sessions: SessionInfo[]; tasks: Task[] }
  | { type: "session"; session: SessionInfo; messages: ChatMessage[] }
  | { type: "session_patch"; session: SessionInfo }
  | { type: "delta"; sessionId: string; text: string }
  | { type: "tool"; sessionId: string; phase: "start" | "end"; name: string }
  | { type: "log"; sessionId: string; text: string }
  | {
      type: "permission";
      sessionId: string;
      requestId: string;
      title: string;
      detail: string;
      options: PermissionOption[];
      changes: PermissionChange[];
      deadline: number;
    }
  | {
      type: "cursor_setting";
      sessionId: string;
      model: string;
      models: CursorModelChoice[];
      fast: boolean;
      fastAvailable: boolean;
    }
  | { type: "browser_frame"; data: string; width: number; height: number }
  | { type: "desktop_frame"; data: string; width: number; height: number }
  | { type: "browser_status"; open: boolean; url: string; title: string; owner: "idle" | "phone" | "agent"; activeId: string; tabs: BrowserTab[]; mobile: boolean; port: number }
  | { type: "git_status"; projectId: string; branch: string; files: GitFile[] }
  | { type: "git_diff"; projectId: string; path: string; diff: string }
  | { type: "committed"; projectId: string; ok: boolean; output: string }
  | { type: "asr_text"; target: "work" | "admin"; text: string }
  | { type: "asr_error"; message: string }
  | { type: "error"; message: string };
