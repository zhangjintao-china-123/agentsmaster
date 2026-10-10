import { useEffect, useMemo, useRef, useState } from "react";
import { AppOutline, AppstoreOutline, GlobalOutline, MessageOutline } from "antd-mobile-icons";
import { Button, List, NavBar, NoticeBar, Popup, Space, TabBar, Tag, TextArea } from "antd-mobile";
import { connectLink, isDirectHost, loadPair, type Pair } from "./link";
import { PairGate } from "./pair-gate";
import { BrowserPane } from "./browser-pane";
import { DesktopPane } from "./desktop-pane";
import {
  ADMIN_AGENT_ID,
  type Agent,
  type ChatMessage,
  type CursorModelChoice,
  type GitFile,
  type ImagePayload,
  type BrowserTab,
  type PermissionChange,
  type PermissionOption,
  type Project,
  type RunnerId,
  type ServerMessage,
  type SessionInfo,
  type Task,
} from "../shared/protocol";

type AppTab = "home" | "browser" | "desktop" | "admin";
type HomeView = "pick" | "session" | "changes" | "tasks";

type Focus = { agentId: string; projectId: string | null };

const runnerLabel: Record<RunnerId, string> = {
  pi: "Pi",
  cursor: "Cursor",
  opencode: "OpenCode",
  claude: "Claude",
  codex: "Codex",
};

function appendDelta(current: ChatMessage[], text: string): ChatMessage[] {
  const last = current.at(-1);
  if (last?.role === "agent") {
    return current.map((item, index) =>
      index === current.length - 1 ? { ...item, text: item.text + text } : item,
    );
  }
  return [...current, { id: crypto.randomUUID(), role: "agent", text, at: Date.now() }];
}

function isAdminSession(session: SessionInfo) {
  return session.agentId === ADMIN_AGENT_ID && !session.projectId;
}

function foldTools(messages: ChatMessage[]): Array<ChatMessage & { count: number }> {
  const folded: Array<ChatMessage & { count: number }> = [];
  for (const message of messages) {
    if (message.role === "tool" && /^(started|completed|tool)$/i.test(message.text)) continue;
    const last = folded.at(-1);
    if (message.role === "tool" && last?.role === "tool" && last.text === message.text) {
      last.count += 1;
      continue;
    }
    folded.push({ ...message, count: 1 });
  }
  return folded;
}

function shrinkImage(file: File): Promise<ImagePayload> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      const scale = Math.min(1, 1280 / Math.max(image.width, image.height, 1));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext("2d");
      if (!context) {
        URL.revokeObjectURL(url);
        reject(new Error("无法读取图片"));
        return;
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const encoded = canvas.toDataURL("image/jpeg", 0.8);
      URL.revokeObjectURL(url);
      resolve({ mediaType: "image/jpeg", data: encoded.slice(encoded.indexOf(",") + 1) });
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("无法读取图片"));
    };
    image.src = url;
  });
}

async function readShots(files: FileList | null): Promise<ImagePayload[]> {
  if (!files) return [];
  const images: ImagePayload[] = [];
  for (const file of files) {
    if (!file.type.startsWith("image/")) continue;
    images.push(await shrinkImage(file));
  }
  return images;
}

function formatTime(ts: number) {
  const date = new Date(ts);
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay
    ? date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })
    : `${date.getMonth() + 1}/${date.getDate()}`;
}

function messageTime(ts?: number) {
  if (!ts) return "";
  const date = new Date(ts);
  const clock = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const sameDay = new Date().toDateString() === date.toDateString();
  return sameDay ? clock : `${date.getMonth() + 1}/${date.getDate()} ${clock}`;
}

function HistorySheet({
  open,
  onClose,
  sessions,
  currentId,
  onOpen,
  onCreate,
}: {
  open: boolean;
  onClose: () => void;
  sessions: SessionInfo[];
  currentId?: string;
  onOpen: (id: string) => void;
  onCreate: () => void;
}) {
  const ordered = [...sessions].sort((a, b) => b.createdAt - a.createdAt);
  return (
    <Popup
      visible={open}
      onMaskClick={onClose}
      bodyStyle={{
        height: "78vh",
        borderTopLeftRadius: 16,
        borderTopRightRadius: 16,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <div className="history-head">
        <strong>历史会话</strong>
        <Button size="small" color="primary" fill="outline" onClick={onCreate}>
          新会话
        </Button>
      </div>
      <div className="history-body">
        {ordered.length === 0 ? (
          <div className="empty">还没有历史会话</div>
        ) : (
          <List>
            {ordered.map((item) => (
              <List.Item
                key={item.id}
                description={item.summary || "暂无摘要"}
                extra={formatTime(item.createdAt)}
                clickable
                onClick={() => onOpen(item.id)}
                className={item.id === currentId ? "current-session" : ""}
              >
                {item.id === currentId ? "当前 · " : ""}
                {item.title || "未命名会话"}
              </List.Item>
            ))}
          </List>
        )}
      </div>
    </Popup>
  );
}

function MessageList({ messages, speaking }: { messages: ChatMessage[]; speaking: string }) {
  return (
    <div className="thread">
      {foldTools(messages).map((message) => (
        <div key={message.id} className={`bubble ${message.role}`}>
          {message.role === "agent" ? <div className="who">{speaking}</div> : null}
          <span className="body">{message.text}{message.count > 1 ? ` × ${message.count}` : ""}</span>
          {message.at ? <div className="when">{messageTime(message.at)}</div> : null}
        </div>
      ))}
    </div>
  );
}

export function App() {
  const [appTab, setAppTab] = useState<AppTab>("home");
  const [homeView, setHomeView] = useState<HomeView>("pick");
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [permission, setPermission] = useState<{
    sessionId: string;
    requestId: string;
    title: string;
    detail: string;
    options: PermissionOption[];
    changes: PermissionChange[];
    deadline: number;
  } | null>(null);
  const [openChange, setOpenChange] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [cursorSetting, setCursorSetting] = useState<{
    sessionId: string;
    model: string;
    models: CursorModelChoice[];
    fast: boolean;
    fastAvailable: boolean;
  } | null>(null);
  const [shots, setShots] = useState<ImagePayload[]>([]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [focus, setFocus] = useState<Focus | null>(null);
  const [project, setProject] = useState<Project | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [runner, setRunner] = useState<RunnerId>("pi");
  const [draft, setDraft] = useState("");
  const [workBusy, setWorkBusy] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [adminSession, setAdminSession] = useState<SessionInfo | null>(null);
  const [adminMessages, setAdminMessages] = useState<ChatMessage[]>([]);
  const [adminDraft, setAdminDraft] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminHistory, setAdminHistory] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [commitDraft, setCommitDraft] = useState("");
  const [branch, setBranch] = useState("");
  const [files, setFiles] = useState<GitFile[]>([]);
  const [diff, setDiff] = useState("");
  const socketRef = useRef<{ send: (payload: unknown) => void } | null>(null);
  const direct = useRef(isDirectHost()).current;
  const pair = useRef<Pair | null>(direct ? null : loadPair()).current;
  const [scanner, setScanner] = useState(false);
  const [browserOwner, setBrowserOwner] = useState<"idle" | "phone" | "agent">("idle");
  const [browserUrl, setBrowserUrl] = useState("");
  const [browserTabs, setBrowserTabs] = useState<BrowserTab[]>([]);
  const [browserActiveId, setBrowserActiveId] = useState("");
  const frameSink = useRef<((frame: { data: string; width: number; height: number }) => void) | null>(null);
  const desktopFrameSink = useRef<((frame: { data: string; width: number; height: number }) => void) | null>(null);

  const send = (payload: unknown) => {
    socketRef.current?.send(payload);
  };

  useEffect(() => {
    if (!direct && !pair) return;
    const link = connectLink({
      pair: direct ? null : pair,
      onOpen: () => setConnected(true),
      onClose: () => setConnected(false),
      onMessage: (message) => apply(message as ServerMessage),
    });
    socketRef.current = link;
    return () => {
      socketRef.current = null;
      link.close();
    };
  }, []);
  const workIdRef = useRef<string | null>(null);
  const adminIdRef = useRef<string | null>(null);

  function apply(message: ServerMessage) {
    if (message.type === "error") {
      setError(message.message);
      setWorkBusy(false);
      setAdminBusy(false);
      return;
    }
    if (message.type === "catalog") {
      setProjects(message.projects);
      setAgents(message.agents);
      setSessions(message.sessions);
    }
    if (message.type === "project") {
      setProject(message.project);
      setSessions((current) => [
        ...message.sessions,
        ...current.filter((item) => item.projectId !== message.project.id),
      ]);
      setTasks(message.tasks);
    }
    if (message.type === "session") {
      const admin = isAdminSession(message.session);
      if (admin) {
        adminIdRef.current = message.session.id;
        setAdminSession(message.session);
        setAdminMessages((current) =>
          message.messages.length > 0 ? message.messages : current.filter((item) => item.role === "user"),
        );
        if (message.messages.length > 0 || message.session.status === "working") {
          setAdminBusy(message.session.status === "working");
        }
      } else {
        workIdRef.current = message.session.id;
        setSession(message.session);
        setMessages((current) =>
          message.messages.length > 0 ? message.messages : current.filter((item) => item.role === "user"),
        );
        setHomeView("session");
        if (message.messages.length > 0 || message.session.status === "working") {
          setWorkBusy(message.session.status === "working");
        }
      }
      setSessions((current) => [
        message.session,
        ...current.filter((item) => item.id !== message.session.id),
      ]);
    }
    if (message.type === "session_patch") {
      setSessions((current) =>
        current.map((item) => (item.id === message.session.id ? message.session : item)),
      );
      setSession((current) => (current?.id === message.session.id ? message.session : current));
      const finished = message.session.status === "done" || message.session.status === "error";
      if (finished) {
        setPermission((current) => (current?.sessionId === message.session.id ? null : current));
      }
      if (finished || message.session.status === "working") {
        if (message.session.id === adminIdRef.current) setAdminBusy(!finished);
        if (message.session.id === workIdRef.current) setWorkBusy(!finished);
      }
    }
    if (message.type === "delta") {
      if (message.sessionId === adminIdRef.current) {
        setAdminMessages((current) => appendDelta(current, message.text));
      } else if (message.sessionId === workIdRef.current) {
        setMessages((current) => appendDelta(current, message.text));
      }
    }
    if (message.type === "tool") {
      const line = { id: crypto.randomUUID(), role: "tool" as const, text: message.name, at: Date.now() };
      if (message.sessionId === adminIdRef.current) {
        setAdminMessages((current) => [...current, line]);
      } else if (message.sessionId === workIdRef.current) {
        setMessages((current) => [...current, line]);
      }
    }
    if (message.type === "permission") {
      setOpenChange(null);
      setPermission({
        sessionId: message.sessionId,
        requestId: message.requestId,
        title: message.title,
        detail: message.detail,
        options: message.options,
        changes: message.changes,
        deadline: message.deadline,
      });
    }
    if (message.type === "cursor_setting") {
      setCursorSetting({
        sessionId: message.sessionId,
        model: message.model,
        models: message.models,
        fast: message.fast,
        fastAvailable: message.fastAvailable,
      });
    }
    if (message.type === "browser_frame") frameSink.current?.(message);
    if (message.type === "desktop_frame") desktopFrameSink.current?.(message);
    if (message.type === "browser_status") {
      setBrowserOwner(message.owner);
      setBrowserUrl(message.url);
      setBrowserTabs(message.tabs ?? []);
      setBrowserActiveId(message.activeId ?? "");
    }
    if (message.type === "log") {
      const line = { id: crypto.randomUUID(), role: "log" as const, text: message.text, at: Date.now() };
      if (message.sessionId === adminIdRef.current) {
        setAdminMessages((current) => [...current, line]);
      } else if (message.sessionId === workIdRef.current) {
        setMessages((current) => [...current, line]);
      }
    }
    if (message.type === "git_status") {
      setBranch(message.branch);
      setFiles(message.files);
    }
    if (message.type === "git_diff") setDiff(message.diff);
    if (message.type === "committed") setError(message.ok ? "" : message.output);
  }

  useEffect(() => {
    if (homeView === "changes" && project) send({ type: "git_status", projectId: project.id });
  }, [homeView, project?.id]);

  useEffect(() => {
    if (!permission) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [permission?.requestId]);

  const listedAgents = agents.filter((item) => item.id !== ADMIN_AGENT_ID);
  const agent = agents.find((item) => item.id === (session?.agentId || focus?.agentId));
  const visibleSessions = sessions.filter((item) => {
    if (!focus) return false;
    if (focus.projectId) return item.projectId === focus.projectId;
    return item.agentId === focus.agentId && !item.projectId;
  });
  const adminSessions = sessions.filter((item) => isAdminSession(item));
  const speaking = agent?.name || (session ? runnerLabel[session.runner] : "Agent");

  const statusText = useMemo(() => {
    if (!connected) return "正在连接服务";
    if (appTab === "browser") return "浏览器";
    if (appTab === "desktop") return "桌面";
    if (appTab === "admin") return "AI管理员";
    if (homeView === "pick") return "选择";
    if (project) return `${project.name} · ${speaking}`;
    return speaking;
  }, [connected, appTab, homeView, project, speaking]);

  function openChat(agentId: string, projectId: string | null) {
    const next = agents.find((item) => item.id === agentId);
    setFocus({ agentId, projectId });
    setProject(projects.find((item) => item.id === projectId) ?? null);
    if (next) setRunner(next.runner);
    setShowHistory(false);
    setAppTab("home");
    setHomeView("session");
    if (projectId) send({ type: "open_project", projectId });
    const recent = sessions
      .filter((item) => item.agentId === agentId && (item.projectId ?? null) === projectId)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (recent) {
      send({ type: "open_session", sessionId: recent.id });
      return;
    }
    workIdRef.current = null;
    setSession(null);
    setMessages([]);
  }

  return (
    <div className="app">
      {(!direct && !pair) || scanner ? (
        <PairGate onCancel={pair ? () => setScanner(false) : undefined} />
      ) : (
      <>
      <NavBar
        back={appTab === "home" && homeView !== "pick" ? "返回" : null}
        onBack={() => {
          if (homeView === "session") {
            workIdRef.current = null;
            setSession(null);
            setMessages([]);
            setShowHistory(false);
            setHomeView("pick");
            return;
          }
          setHomeView("session");
        }}
        right={
          appTab === "admin" || (appTab === "home" && homeView === "session") ? (
            <Space style={{ "--gap": "0px" }}>
              <Button
                size="mini"
                fill="none"
                onClick={() => {
                  if (appTab === "admin") {
                    adminIdRef.current = null;
                    setAdminSession(null);
                    setAdminMessages([]);
                    setAdminHistory(false);
                    setAdminBusy(false);
                    return;
                  }
                  workIdRef.current = null;
                  setSession(null);
                  setMessages([]);
                  setShowHistory(false);
                  setWorkBusy(false);
                }}
              >
                新会话
              </Button>
              <Button
                size="mini"
                fill="none"
                color="primary"
                onClick={() => (appTab === "admin" ? setAdminHistory(true) : setShowHistory(true))}
              >
                历史
              </Button>
            </Space>
          ) : (
            <Tag color={connected ? "success" : "warning"} fill="outline">
              {connected ? "在线" : "连接中"}
            </Tag>
          )
        }
      >
        {statusText}
      </NavBar>
      {error ? (
        <NoticeBar content={error} color="alert" closeable onClose={() => setError("")} />
      ) : null}
      <main className={appTab === "browser" || appTab === "desktop" ? "main-fill" : undefined}>
        {appTab === "home" && homeView === "pick" ? (
          <>
            {!direct ? (
              <div className="scan-entry">
                <Button color="primary" block size="large" onClick={() => setScanner(true)}>
                  扫一扫
                </Button>
              </div>
            ) : null}
            <List header="直接和 Agent 说">
              {listedAgents.map((item) => (
                <List.Item
                  key={item.id}
                  description={runnerLabel[item.runner]}
                  clickable
                  onClick={() => openChat(item.id, null)}
                >
                  {item.name}
                </List.Item>
              ))}
            </List>
            <List header="选一个项目">
              {projects.map((item) => {
                const bound = listedAgents.find((agentItem) => agentItem.id === item.agentId);
                return (
                  <List.Item
                    key={item.id}
                    description={bound ? bound.name : "未绑定 agent"}
                    clickable
                    onClick={() => {
                      if (!bound) {
                        setError("这个项目还没在配置页绑定 agent");
                        return;
                      }
                      openChat(bound.id, item.id);
                    }}
                  >
                    {item.name}
                  </List.Item>
                );
              })}
            </List>
          </>
        ) : null}

        {appTab === "home" && homeView === "session" ? (
          <section className="session">
            <div className="who-line">
              {session ? `当前会话 · ${speaking}` : `新会话 · 发给 ${speaking}`}
            </div>
            <MessageList messages={messages} speaking={speaking} />
            {session?.runner === "cursor" && cursorSetting?.sessionId === session.id ? (
              <div className="cursor-bar">
                <select
                  value={cursorSetting.model}
                  onChange={(event) => {
                    const model = event.target.value;
                    setCursorSetting({ ...cursorSetting, model });
                    send({ type: "cursor_setting", sessionId: session.id, model });
                  }}
                >
                  {cursorSetting.models.map((model) => (
                    <option key={model.id || "auto"} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                </select>
                {cursorSetting.fastAvailable ? (
                  <Button
                    size="small"
                    color="primary"
                    fill={cursorSetting.fast ? "solid" : "outline"}
                    onClick={() => {
                      const fast = !cursorSetting.fast;
                      setCursorSetting({ ...cursorSetting, fast });
                      send({ type: "cursor_setting", sessionId: session.id, fast });
                    }}
                  >
                    Fast
                  </Button>
                ) : null}
              </div>
            ) : null}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                const text = draft.trim();
                if (!focus || !text) return;
                const images = shots;
                setMessages((current) => [
                  ...current,
                  { id: crypto.randomUUID(), role: "user", text, at: Date.now() },
                ]);
                setWorkBusy(true);
                if (session) {
                  send({ type: "prompt", sessionId: session.id, text, images });
                } else {
                  send({
                    type: "start",
                    agentId: focus.agentId,
                    projectId: focus.projectId,
                    text,
                    images,
                  });
                }
                setDraft("");
                setShots([]);
              }}
            >
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  void readShots(event.target.files).then((images) => {
                    setShots((current) => [...current, ...images].slice(0, 4));
                    event.target.value = "";
                  });
                }}
              />
              <div className="composer-main">
                {shots.length ? <div className="shot-count">已选 {shots.length} 张图片</div> : null}
                <TextArea
                  value={draft}
                  autoSize={{ minRows: 1, maxRows: 4 }}
                  onChange={setDraft}
                  placeholder={workBusy ? "可以先写下一句" : session ? `接着 ${speaking} 说` : `发给 ${speaking}`}
                />
              </div>
              <Button type="button" fill="none" onClick={() => fileRef.current?.click()}>
                图片
              </Button>
              {workBusy && session ? (
                <Button
                  type="button"
                  color="danger"
                  fill="outline"
                  onClick={() => send({ type: "cancel", sessionId: session.id })}
                >
                  停止
                </Button>
              ) : null}
              <Button type="submit" color="primary" disabled={!draft.trim()}>
                发送
              </Button>
            </form>
            {project ? (
              <div className="subnav">
                <Button size="small" fill="none" onClick={() => setHomeView("changes")}>
                  变更
                </Button>
                <Button size="small" fill="none" onClick={() => setHomeView("tasks")}>
                  待办
                </Button>
              </div>
            ) : null}
            <HistorySheet
              open={showHistory}
              onClose={() => setShowHistory(false)}
              sessions={visibleSessions}
              currentId={session?.id}
              onCreate={() => {
                workIdRef.current = null;
                setSession(null);
                setMessages([]);
                setShowHistory(false);
                setWorkBusy(false);
              }}
              onOpen={(id) => {
                setShowHistory(false);
                if (id !== session?.id) send({ type: "open_session", sessionId: id });
              }}
            />
          </section>
        ) : null}

        {appTab === "home" && homeView === "changes" ? (
          <section>
            <List header={branch || "无分支"}>
              {files.map((file) => (
                <List.Item
                  key={file.path}
                  description={file.status}
                  clickable
                  onClick={() =>
                    project && send({ type: "git_diff", projectId: project.id, path: file.path })
                  }
                >
                  {file.path}
                </List.Item>
              ))}
            </List>
            {diff ? <pre className="diff">{diff}</pre> : null}
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!project || !commitDraft.trim()) return;
                send({ type: "git_commit", projectId: project.id, message: commitDraft.trim() });
                setCommitDraft("");
              }}
            >
              <TextArea
                value={commitDraft}
                autoSize={{ minRows: 1, maxRows: 3 }}
                onChange={setCommitDraft}
                placeholder="提交说明"
              />
              <Button type="submit" color="primary">
                提交
              </Button>
            </form>
          </section>
        ) : null}

        {appTab === "home" && homeView === "tasks" ? (
          <section>
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                if (!project || !taskDraft.trim()) return;
                send({ type: "add_task", projectId: project.id, title: taskDraft.trim() });
                setTaskDraft("");
              }}
            >
              <TextArea
                value={taskDraft}
                autoSize={{ minRows: 1, maxRows: 3 }}
                onChange={setTaskDraft}
                placeholder="一条待办"
              />
              <Button type="submit" color="primary">
                添加
              </Button>
            </form>
            <List>
              {tasks.map((task) => (
                <List.Item
                  key={task.id}
                  description={task.status}
                  extra={
                    task.status === "todo" ? (
                      <Button
                        size="small"
                        color="primary"
                        onClick={() => send({ type: "start_task", taskId: task.id, runner })}
                      >
                        开始
                      </Button>
                    ) : null
                  }
                >
                  {task.title}
                </List.Item>
              ))}
            </List>
          </section>
        ) : null}

        {appTab === "admin" ? (
          <section className="session">
            <div className="who-line">
              {adminSession ? "当前会话 · AI管理员" : "新会话 · 发给 AI管理员"}
            </div>
            <MessageList messages={adminMessages} speaking="AI管理员" />
            <form
              className="composer"
              onSubmit={(event) => {
                event.preventDefault();
                const text = adminDraft.trim();
                if (!text) return;
                setAdminMessages((current) => [
                  ...current,
                  { id: crypto.randomUUID(), role: "user", text, at: Date.now() },
                ]);
                setAdminBusy(true);
                if (adminSession) {
                  send({ type: "prompt", sessionId: adminSession.id, text });
                } else {
                  send({
                    type: "start",
                    agentId: ADMIN_AGENT_ID,
                    projectId: null,
                    text,
                  });
                }
                setAdminDraft("");
              }}
            >
              <TextArea
                value={adminDraft}
                autoSize={{ minRows: 1, maxRows: 4 }}
                onChange={setAdminDraft}
                placeholder={adminBusy ? "可以先写下一句" : adminSession ? "接着 AI管理员 说" : "发给 AI管理员"}
              />
              {adminBusy && adminSession ? (
                <Button
                  type="button"
                  color="danger"
                  fill="outline"
                  onClick={() => send({ type: "cancel", sessionId: adminSession.id })}
                >
                  停止
                </Button>
              ) : null}
              <Button type="submit" color="primary" disabled={!adminDraft.trim()}>
                发送
              </Button>
            </form>
            <HistorySheet
              open={adminHistory}
              onClose={() => setAdminHistory(false)}
              sessions={adminSessions}
              currentId={adminSession?.id}
              onCreate={() => {
                adminIdRef.current = null;
                setAdminSession(null);
                setAdminMessages([]);
                setAdminHistory(false);
                setAdminBusy(false);
              }}
              onOpen={(id) => {
                setAdminHistory(false);
                if (id !== adminSession?.id) send({ type: "open_session", sessionId: id });
              }}
            />
          </section>
        ) : null}
        {appTab === "browser" ? (
          <BrowserPane
            owner={browserOwner}
            pageUrl={browserUrl}
            tabs={browserTabs}
            activeId={browserActiveId}
            onWatch={(on) => send({ type: "browser_watch", on })}
            onControl={(on) => send({ type: "browser_control", on })}
            onNav={(url) => send({ type: "browser_nav", url })}
            onSwitch={(targetId) => send({ type: "browser_switch", targetId })}
            onInput={(input) => send({ type: "browser_input", ...input })}
            bindFrame={(sink) => { frameSink.current = sink; }}
          />
        ) : null}
        {appTab === "desktop" ? (
          <DesktopPane
            onWatch={(on) => send({ type: "desktop_watch", on })}
            onInput={(input) => send({ type: "desktop_input", ...input })}
            bindFrame={(sink) => { desktopFrameSink.current = sink; }}
          />
        ) : null}
      </main>
      {permission ? (
        <div className="permission-card">
          <div className="permission-kicker">Cursor 要执行</div>
          <div className="permission-title">{permission.title}</div>
          <div className="permission-kicker">
            还剩 {Math.max(0, Math.ceil((permission.deadline - now) / 1000))} 秒，未选择会拒绝
          </div>
          {permission.detail ? <div className="permission-detail">{permission.detail}</div> : null}
          {permission.changes.map((change) => (
            <div key={change.path} className="permission-change">
              <button type="button" onClick={() => setOpenChange((current) => (current === change.path ? null : change.path))}>
                {change.path}
              </button>
              <pre>{openChange === change.path ? change.diff : change.summary}</pre>
            </div>
          ))}
          <div className="permission-actions">
            {permission.options.map((option) => (
              <Button
                key={option.id}
                size="small"
                color={option.kind.startsWith("reject") ? "danger" : "primary"}
                fill={option.kind === "allow_once" ? "solid" : "outline"}
                onClick={() => {
                  send({
                    type: "permission",
                    sessionId: permission.sessionId,
                    requestId: permission.requestId,
                    optionId: option.id,
                  });
                  setPermission(null);
                }}
              >
                {option.name}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
      <TabBar activeKey={appTab} onChange={(key) => setAppTab(key as AppTab)} safeArea>
        <TabBar.Item key="home" icon={<AppOutline />} title="选择" />
        <TabBar.Item key="browser" icon={<GlobalOutline />} title="浏览器" />
        <TabBar.Item key="desktop" icon={<AppstoreOutline />} title="桌面" />
        <TabBar.Item key="admin" icon={<MessageOutline />} title="AI管理员" />
      </TabBar>
      </>
      )}
    </div>
  );
}
