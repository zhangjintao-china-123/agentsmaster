<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import FrameView from "../../components/frame-view.vue";
import MarkdownText from "../../components/markdown-text.vue";
import PairGate from "../../components/pair-gate.vue";
import { appendDelta, foldTools, formatTime, messageTime, runnerLabel, uid } from "../../chat";
import { connectLink, isDirectHost, loadPair } from "../../link";
import { startCapture, type Capture } from "../../voice";
import { ADMIN_AGENT_ID, type Agent, type BrowserTab, type ChatMessage, type CursorModelChoice, type GitFile, type PermissionChange, type PermissionOption, type Project, type RunnerId, type ServerMessage, type SessionInfo, type Task } from "../../../../src/shared/protocol";

type Tab = "home" | "browser" | "desktop" | "admin";
type HomeView = "pick" | "session" | "changes" | "tasks";
type Frame = { data: string; width: number; height: number };

const appTab = ref<Tab>("home");
const homeView = ref<HomeView>("pick");
const connected = ref(false);
const error = ref("");
const copied = ref(false);
const projects = ref<Project[]>([]);
const agents = ref<Agent[]>([]);
const sessions = ref<SessionInfo[]>([]);
const tasks = ref<Task[]>([]);
const focus = ref<{ agentId: string; projectId: string | null } | null>(null);
const project = ref<Project | null>(null);
const session = ref<SessionInfo | null>(null);
const messages = ref<ChatMessage[]>([]);
const draft = ref("");
const workBusy = ref(false);
const showHistory = ref(false);
const adminSession = ref<SessionInfo | null>(null);
const adminMessages = ref<ChatMessage[]>([]);
const adminDraft = ref("");
const adminBusy = ref(false);
const adminHistory = ref(false);
const taskDraft = ref("");
const commitDraft = ref("");
const branch = ref("");
const files = ref<GitFile[]>([]);
const diff = ref("");
const browserOwner = ref<"idle" | "phone" | "agent">("idle");
const browserUrl = ref("");
const browserTabs = ref<BrowserTab[]>([]);
const browserActiveId = ref("");
const browserMobile = ref(false);
const browserPort = ref(9222);
const navDraft = ref("");
const typeDraft = ref("");
const portDraft = ref("9222");
const browserBox = ref<"" | "open" | "type" | "port">("");
const desktopDraft = ref("");
const cursorSetting = ref<{ sessionId: string; model: string; models: CursorModelChoice[]; fast: boolean; fastAvailable: boolean } | null>(null);
const permission = ref<{ sessionId: string; requestId: string; title: string; detail: string; options: PermissionOption[]; changes: PermissionChange[]; deadline: number } | null>(null);
const openChange = ref("");
const now = ref(Date.now());
const browserFrame = ref<{ paint: (frame: Frame) => void } | null>(null);
const desktopFrame = ref<{ paint: (frame: Frame) => void } | null>(null);

let workId: string | null = null;
let adminId: string | null = null;
let link: { send: (payload: unknown) => void; close: () => void } | null = null;
let clock = 0;

const direct = isDirectHost();
const pair = direct ? null : loadPair();
const scanning = ref(!direct && !pair);
const agent = computed(() => agents.value.find((item) => item.id === (session.value?.agentId || focus.value?.agentId)));
const speaking = computed(() => {
  const runner = session.value?.runner || agent.value?.runner;
  if (runner && runner !== "pi") return runnerLabel[runner];
  return agent.value?.name || "Agent";
});
const visibleSessions = computed(() => sessions.value.filter((item) => {
  if (!focus.value) return false;
  if (focus.value.projectId) return item.projectId === focus.value.projectId;
  return item.agentId === focus.value.agentId && !item.projectId;
}));
const adminSessions = computed(() => sessions.value.filter((item) => item.agentId === ADMIN_AGENT_ID && !item.projectId));
const title = computed(() => {
  if (!connected.value) return "正在连接服务";
  if (appTab.value === "browser") return "浏览器";
  if (appTab.value === "desktop") return "桌面";
  if (appTab.value === "admin") return "AI管理员";
  if (homeView.value === "pick") return "项目";
  if (project.value) return `${project.value.name} · ${speaking.value}`;
  return speaking.value;
});
const moreOpen = ref(false);
const showChatTools = computed(() => appTab.value === "admin" || (appTab.value === "home" && homeView.value === "session"));
const canPickModel = computed(() => appTab.value === "home" && session.value?.runner === "cursor" && cursorSetting.value?.sessionId === session.value.id && cursorSetting.value.models.length > 0);
const modelName = computed(() => {
  const setting = cursorSetting.value;
  if (!canPickModel.value || !setting) return "模型";
  return setting.models.find((item) => item.id === setting.model)?.name || setting.model || "模型";
});
const modelIndex = computed(() => {
  const setting = cursorSetting.value;
  if (!setting) return 0;
  const index = setting.models.findIndex((item) => item.id === setting.model);
  return index < 0 ? 0 : index;
});
const folded = computed(() => foldTools(messages.value));
const foldedAdmin = computed(() => foldTools(adminMessages.value));
const workWaiting = computed(() => awaitingReply(folded.value, workBusy.value));
const adminWaiting = computed(() => awaitingReply(foldedAdmin.value, adminBusy.value));
const openTraces = ref<Record<string, boolean>>({});
const workScroll = ref(0);
const adminScroll = ref(0);

function awaitingReply(items: ReturnType<typeof foldTools>, busy: boolean) {
  if (!busy) return false;
  const last = items.at(-1);
  if (!last) return true;
  return last.kind === "message" && last.role === "user";
}

function threadScroller() {
  return [...document.querySelectorAll(".thread .uni-scroll-view")].find((node) => {
    const style = getComputedStyle(node);
    return style.overflowY === "auto" || style.overflowY === "scroll";
  }) as HTMLElement | undefined;
}

let pinTick = 0;

function pinThread(which: "work" | "admin") {
  nextTick(() => {
    const node = threadScroller();
    pinTick += 1;
    const top = (node?.scrollHeight || 0) + pinTick;
    if (which === "work") workScroll.value = top;
    else adminScroll.value = top;
    if (node) node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => {
      const again = threadScroller();
      if (!again) return;
      again.scrollTop = again.scrollHeight;
    });
  });
}

watch(
  () => messages.value.map((item) => `${item.id}:${item.text.length}`).join("\n"),
  () => {
    if (appTab.value === "home" && homeView.value === "session") pinThread("work");
  },
  { flush: "post" },
);
watch(
  () => adminMessages.value.map((item) => `${item.id}:${item.text.length}`).join("\n"),
  () => {
    if (appTab.value === "admin") pinThread("admin");
  },
  { flush: "post" },
);
watch(workWaiting, (waiting) => {
  if (waiting && appTab.value === "home" && homeView.value === "session") pinThread("work");
});
watch(adminWaiting, (waiting) => {
  if (waiting && appTab.value === "admin") pinThread("admin");
});

function toggleTrace(id: string) {
  openTraces.value = { ...openTraces.value, [id]: !openTraces.value[id] };
}
const historyItems = computed(() => [...(showHistory.value ? visibleSessions.value : adminSessions.value)].sort((a, b) => b.createdAt - a.createdAt));

function send(payload: unknown) {
  link?.send(payload);
}

const voiceTarget = ref<"" | "work" | "admin">("");
const voicePhase = ref<"" | "recording" | "recognizing">("");
let voiceCapture: Capture | null = null;
let voiceTimer = 0;
let voiceWait = 0;
let voiceStarted = 0;
let lastTouch = 0;

function onVoiceDown(target: "work" | "admin", event: Event) {
  if (event.type === "touchstart") lastTouch = Date.now();
  if (event.type === "mousedown" && Date.now() - lastTouch < 700) return;
  if (voicePhase.value === "recognizing" || voiceCapture) return;
  voiceStarted = Date.now();
  voiceTarget.value = target;
  voiceCapture = startCapture();
  voiceTimer = window.setTimeout(() => {
    if (!voiceCapture) return;
    voicePhase.value = "recording";
    (document.activeElement as HTMLElement | null)?.blur();
  }, 420);
  const end = () => {
    window.removeEventListener("touchend", end);
    window.removeEventListener("touchcancel", end);
    window.removeEventListener("mouseup", end);
    onVoiceUp();
  };
  window.addEventListener("touchend", end);
  window.addEventListener("touchcancel", end);
  window.addEventListener("mouseup", end);
}

function onVoiceUp() {
  window.clearTimeout(voiceTimer);
  const current = voiceCapture;
  const target = voiceTarget.value;
  const held = Date.now() - voiceStarted;
  voiceCapture = null;
  if (!current) return;
  if (held < 420 || voicePhase.value !== "recording" || (target !== "work" && target !== "admin")) {
    current.cancel();
    voicePhase.value = "";
    return;
  }
  void finishVoice(current, target);
}

async function finishVoice(current: Capture, target: "work" | "admin") {
  voicePhase.value = "recognizing";
  window.clearTimeout(voiceWait);
  voiceWait = window.setTimeout(() => {
    if (voicePhase.value !== "recognizing") return;
    voicePhase.value = "";
    error.value = "语音识别超时";
  }, 25000);
  try {
    const audio = await current.stop();
    send({ type: "asr", target, mime: "audio/wav", audio });
  } catch (cause) {
    window.clearTimeout(voiceWait);
    voicePhase.value = "";
    error.value = cause instanceof Error ? cause.message : "录音没有完成";
  }
}

function fillDraft(target: "work" | "admin", text: string) {
  const box = target === "admin" ? adminDraft : draft;
  box.value = box.value.trim() ? `${box.value.trim()} ${text}` : text;
}

function apply(message: ServerMessage) {
  if (message.type === "error") {
    error.value = message.message;
    workBusy.value = false;
    adminBusy.value = false;
    if (voicePhase.value === "recognizing") {
      window.clearTimeout(voiceWait);
      voicePhase.value = "";
    }
    return;
  }
  if (message.type === "asr_text") {
    window.clearTimeout(voiceWait);
    fillDraft(message.target, message.text);
    voicePhase.value = "";
    if (message.target === "admin") sendAdmin();
    else sendWork();
    return;
  }
  if (message.type === "asr_error") {
    window.clearTimeout(voiceWait);
    voicePhase.value = "";
    error.value = message.message;
    return;
  }
  if (message.type === "catalog") {
    projects.value = message.projects;
    agents.value = message.agents;
    sessions.value = message.sessions;
  }
  if (message.type === "project") {
    project.value = message.project;
    sessions.value = [...message.sessions, ...sessions.value.filter((item) => item.projectId !== message.project.id)];
    tasks.value = message.tasks;
  }
  if (message.type === "session") {
    const admin = message.session.agentId === ADMIN_AGENT_ID && !message.session.projectId;
    if (admin) {
      adminId = message.session.id;
      adminSession.value = message.session;
      adminMessages.value = message.messages.length > 0 ? message.messages : adminMessages.value.filter((item) => item.role === "user");
      if (message.messages.length > 0 || message.session.status === "working") adminBusy.value = message.session.status === "working";
    } else {
      workId = message.session.id;
      session.value = message.session;
      messages.value = message.messages.length > 0 ? message.messages : messages.value.filter((item) => item.role === "user");
      homeView.value = "session";
      if (message.messages.length > 0 || message.session.status === "working") workBusy.value = message.session.status === "working";
    }
    sessions.value = [message.session, ...sessions.value.filter((item) => item.id !== message.session.id)];
  }
  if (message.type === "session_patch") {
    sessions.value = sessions.value.map((item) => (item.id === message.session.id ? message.session : item));
    if (session.value?.id === message.session.id) session.value = message.session;
    const finished = message.session.status === "done" || message.session.status === "error";
    if (finished && permission.value?.sessionId === message.session.id) permission.value = null;
    if (finished || message.session.status === "working") {
      if (message.session.id === adminId) adminBusy.value = !finished;
      if (message.session.id === workId) workBusy.value = !finished;
    }
  }
  if (message.type === "delta") {
    if (message.sessionId === adminId) adminMessages.value = appendDelta(adminMessages.value, message.text);
    else if (message.sessionId === workId) messages.value = appendDelta(messages.value, message.text);
  }
  if (message.type === "tool" || message.type === "log") {
    const line: ChatMessage = { id: uid(), role: message.type === "tool" ? "tool" : "log", text: message.type === "tool" ? message.name : message.text, at: Date.now() };
    if (message.sessionId === adminId) adminMessages.value = [...adminMessages.value, line];
    else if (message.sessionId === workId) messages.value = [...messages.value, line];
  }
  if (message.type === "permission") {
    openChange.value = "";
    permission.value = message;
    now.value = Date.now();
  }
  if (message.type === "cursor_setting") cursorSetting.value = message;
  if (message.type === "browser_frame") browserFrame.value?.paint(message);
  if (message.type === "desktop_frame") desktopFrame.value?.paint(message);
  if (message.type === "browser_status") {
    browserOwner.value = message.owner;
    browserUrl.value = message.url;
    browserTabs.value = message.tabs ?? [];
    browserActiveId.value = message.activeId ?? "";
    browserMobile.value = message.mobile;
    if (message.port) browserPort.value = message.port;
  }
  if (message.type === "git_status") {
    branch.value = message.branch;
    files.value = message.files;
  }
  if (message.type === "git_diff") diff.value = message.diff;
  if (message.type === "committed") error.value = message.ok ? "" : message.output;
}

function onBrowserInput(event: Record<string, unknown>) {
  if (browserOwner.value === "agent") return;
  send({ type: "browser_input", ...event });
}

function phoneScreen() {
  const info = uni.getSystemInfoSync();
  let width = Math.round(info.screenWidth || window.screen.width || 390);
  let height = Math.round(info.screenHeight || window.screen.height || 844);
  if (width > height) [width, height] = [height, width];
  if (width < 320 || width > 520) return { width: 390, height: 844, scale: 3 };
  const scale = Math.min(3, Math.max(2, Math.round(info.pixelRatio || window.devicePixelRatio || 3)));
  return { width, height, scale };
}

function setMobile(on: boolean) {
  if (browserOwner.value === "agent") return;
  if (!on && !browserMobile.value) return;
  const screen = phoneScreen();
  browserMobile.value = on;
  send({ type: "browser_mobile", on, ...screen });
}

function openChat(agentId: string, projectId: string | null) {
  const next = agents.value.find((item) => item.id === agentId);
  focus.value = { agentId, projectId };
  project.value = projects.value.find((item) => item.id === projectId) ?? null;
  showHistory.value = false;
  appTab.value = "home";
  homeView.value = "session";
  if (projectId) send({ type: "open_project", projectId });
  const recent = sessions.value
    .filter((item) => item.agentId === agentId && (item.projectId ?? null) === projectId)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  if (recent) {
    send({ type: "open_session", sessionId: recent.id });
    return;
  }
  workId = null;
  session.value = null;
  messages.value = [];
  void next;
}

let copiedTimer = 0;

async function copyText(text: string) {
  const value = text.trim();
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "true");
    area.style.position = "fixed";
    area.style.left = "-9999px";
    document.body.append(area);
    area.select();
    document.execCommand("copy");
    area.remove();
  }
  copied.value = true;
  window.clearTimeout(copiedTimer);
  copiedTimer = window.setTimeout(() => {
    copied.value = false;
  }, 1200);
}

function sendWork() {
  const text = draft.value.trim();
  if (!focus.value || !text) return;
  messages.value = [...messages.value, { id: uid(), role: "user", text, at: Date.now() }];
  workBusy.value = true;
  if (session.value) send({ type: "prompt", sessionId: session.value.id, text });
  else send({ type: "start", agentId: focus.value.agentId, projectId: focus.value.projectId, text });
  draft.value = "";
}

function tabLabel(tab: BrowserTab) {
  const title = tab.title.trim();
  if (title && title !== "about:blank") return title;
  try {
    return new URL(tab.url).host || "标签";
  } catch {
    return "标签";
  }
}

function submitBrowserType() {
  const text = typeDraft.value.trim();
  if (!text) return;
  send({ type: "browser_input", kind: "type", text });
  typeDraft.value = "";
}

function openBrowserBox(kind: "open" | "type" | "port") {
  if (browserOwner.value === "agent") return;
  if (kind === "open") navDraft.value = browserUrl.value.startsWith("http") ? browserUrl.value : "";
  else if (kind === "port") portDraft.value = String(browserPort.value);
  else typeDraft.value = "";
  browserBox.value = kind;
}

function confirmBrowserBox() {
  if (browserOwner.value === "agent") return;
  if (browserBox.value === "open" && navDraft.value.trim()) send({ type: "browser_nav", url: navDraft.value.trim() });
  if (browserBox.value === "type") submitBrowserType();
  if (browserBox.value === "port") {
    const value = Number(portDraft.value.trim());
    if (!Number.isInteger(value) || value < 1 || value > 65535) {
      error.value = "端口要在 1 到 65535 之间";
      return;
    }
    error.value = "";
    browserPort.value = value;
    send({ type: "browser_port", port: value });
  }
  browserBox.value = "";
}

function submitDesktopType() {
  const text = desktopDraft.value;
  if (!text) return;
  send({ type: "desktop_input", kind: "type", text });
  desktopDraft.value = "";
}

function sendAdmin() {
  const text = adminDraft.value.trim();
  if (!text) return;
  adminMessages.value = [...adminMessages.value, { id: uid(), role: "user", text, at: Date.now() }];
  adminBusy.value = true;
  if (adminSession.value) send({ type: "prompt", sessionId: adminSession.value.id, text });
  else send({ type: "start", agentId: ADMIN_AGENT_ID, projectId: null, text });
  adminDraft.value = "";
}

function back() {
  if (homeView.value === "session") {
    workId = null;
    session.value = null;
    messages.value = [];
    showHistory.value = false;
    homeView.value = "pick";
    return;
  }
  homeView.value = "session";
}

function freshWork() {
  workId = null;
  session.value = null;
  messages.value = [];
  showHistory.value = false;
  workBusy.value = false;
}

function freshAdmin() {
  adminId = null;
  adminSession.value = null;
  adminMessages.value = [];
  adminHistory.value = false;
  adminBusy.value = false;
}

function pickModel(event: { detail?: { value?: string | number } }) {
  const setting = cursorSetting.value;
  const sessionId = session.value?.id;
  if (!setting || !sessionId) return;
  const model = setting.models[Number(event.detail?.value)];
  if (!model) return;
  cursorSetting.value = { ...setting, model: model.id };
  send({ type: "cursor_setting", sessionId, model: model.id });
}

function toggleFast() {
  const setting = cursorSetting.value;
  const sessionId = session.value?.id;
  if (!setting || !sessionId) return;
  const fast = !setting.fast;
  cursorSetting.value = { ...setting, fast };
  send({ type: "cursor_setting", sessionId, fast });
  moreOpen.value = false;
}

function openHistoryFromMenu() {
  moreOpen.value = false;
  if (appTab.value === "admin") adminHistory.value = true;
  else showHistory.value = true;
}

watch([appTab, homeView], () => {
  moreOpen.value = false;
});

watch(appTab, (tab, previous) => {
  if (previous === "browser") send({ type: "browser_watch", on: false });
  if (previous === "desktop") send({ type: "desktop_watch", on: false });
  if (tab === "browser") send({ type: "browser_watch", on: true });
  if (tab === "desktop") send({ type: "desktop_watch", on: true });
  if (tab === "home" && homeView.value === "session") pinThread("work");
  if (tab === "admin") pinThread("admin");
});

watch(homeView, (view) => {
  if (view === "changes" && project.value) send({ type: "git_status", projectId: project.value.id });
  if (view === "session") pinThread("work");
});

watch(permission, (value) => {
  clearInterval(clock);
  if (!value) return;
  clock = setInterval(() => { now.value = Date.now(); }, 1000) as unknown as number;
});

if (direct || pair) {
  link = connectLink({
    pair,
    onOpen: () => {
      connected.value = true;
      if (appTab.value === "browser") send({ type: "browser_watch", on: true });
      if (appTab.value === "desktop") send({ type: "desktop_watch", on: true });
    },
    onClose: () => { connected.value = false; },
    onMessage: (message) => apply(message as ServerMessage),
  });
}

function finishPair() {
  location.replace(location.pathname + location.search);
}
onUnmounted(() => {
  link?.close();
  clearInterval(clock);
  window.clearTimeout(voiceTimer);
  window.clearTimeout(voiceWait);
  voiceCapture?.cancel();
});
</script>

<template>
  <view class="screen">
    <PairGate v-if="scanning" :cancelable="!!pair" @done="finishPair" @cancel="scanning = false" />
    <template v-else>
    <view class="bar">
      <text v-if="appTab === 'home' && homeView !== 'pick'" class="back" @click="back">返回</text>
      <text v-else class="back" />
      <text class="title">{{ title }}</text>
      <text class="state" :class="{ on: connected }">{{ connected ? "在线" : "连接中" }}</text>
    </view>
    <view v-if="showChatTools" class="top-actions">
      <text class="top-btn" @click="appTab === 'admin' ? freshAdmin() : freshWork()">新会话</text>
      <picker v-if="canPickModel && cursorSetting" :value="modelIndex" :range="cursorSetting.models.map((item) => item.name)" @change="pickModel">
        <view class="top-btn">{{ modelName }}</view>
      </picker>
      <text v-else class="top-btn">{{ modelName }}</text>
      <view class="more-wrap">
        <text class="top-btn" @click.stop="moreOpen = !moreOpen">更多</text>
      </view>
    </view>
    <view v-if="moreOpen" class="more-mask" @click="moreOpen = false">
      <view class="more-menu" @click.stop>
        <text @click="openHistoryFromMenu">历史</text>
        <text v-if="appTab === 'home' && project" @click="moreOpen = false; homeView = 'changes'">变更</text>
        <text v-if="appTab === 'home' && project" @click="moreOpen = false; homeView = 'tasks'">待办</text>
        <text v-if="canPickModel && cursorSetting?.fastAvailable" @click="toggleFast">Fast · {{ cursorSetting.fast ? "开" : "关" }}</text>
      </view>
    </view>
    <view v-if="error" class="alert" @click="error = ''">{{ error }}</view>

    <scroll-view v-if="appTab === 'home' && homeView === 'pick'" scroll-y class="body">
      <view v-if="!direct" class="scan-entry">
        <text class="pair-button" @click="scanning = true">扫一扫</text>
      </view>
      <view
        v-for="item in projects"
        :key="item.id"
        class="row"
        @click="item.agentId ? openChat(item.agentId, item.id) : (error = '这个项目还没有通道')"
      >
        <view class="project-text">
          <text>{{ item.name }}</text>
          <text class="meta project-path">{{ item.path }}</text>
        </view>
        <text class="meta">{{ runnerLabel[item.runner] || "Cursor" }}</text>
      </view>
      <view v-if="projects.length === 0" class="empty">还没有项目。先在电脑的配置页登记。</view>
    </scroll-view>

    <view v-else-if="appTab === 'home' && homeView === 'session'" class="body column">
      <scroll-view scroll-y class="thread" :scroll-top="workScroll">
        <view class="thread-inner">
          <template v-for="item in folded" :key="item.id">
            <view v-if="item.kind === 'trace'" class="trace">
              <text class="trace-head" @click="toggleTrace(item.id)">{{ openTraces[item.id] ? "收起执行过程" : `执行过程 · ${item.lines.length} 条` }}</text>
              <view v-if="openTraces[item.id]" class="trace-body">
                <view v-for="(line, index) in item.lines" :key="index" class="trace-row">
                  <text v-if="line.at" class="trace-time">{{ messageTime(line.at) }}</text>
                  <text class="trace-line" user-select>{{ line.text }}</text>
                  <text class="copy" @click="copyText(line.text)">复制</text>
                </view>
              </view>
            </view>
            <view v-else class="bubble" :class="item.role" @longpress="copyText(item.text)">
              <text v-if="item.role === 'agent'" class="who-mini">{{ speaking }}</text>
              <MarkdownText :text="item.text" :tone="item.role === 'user' ? 'user' : 'agent'" />
              <view class="bubble-foot">
                <text v-if="item.at" class="when">{{ messageTime(item.at) }}</text>
                <text class="copy" @click.stop="copyText(item.text)">复制</text>
              </view>
            </view>
          </template>
          <view v-if="workWaiting" class="bubble agent wait">
            <text class="who-mini">{{ speaking }}</text>
            <view class="dots">
              <view class="dot" />
              <view class="dot" />
              <view class="dot" />
            </view>
          </view>
        </view>
      </scroll-view>
      <view class="composer">
        <view class="input-wrap" @touchstart="onVoiceDown('work', $event)" @mousedown="onVoiceDown('work', $event)" @contextmenu.prevent>
          <textarea v-model="draft" auto-height class="input" placeholder="长按这里说话" />
        </view>
        <text v-if="workBusy && session" class="stop" @touchstart.stop @mousedown.stop @click="send({ type: 'cancel', sessionId: session.id })">停止</text>
        <text class="send" :class="{ off: !draft.trim() }" @touchstart.stop @mousedown.stop @click="sendWork">发送</text>
      </view>
    </view>

    <scroll-view v-else-if="appTab === 'home' && homeView === 'changes'" scroll-y class="body">
      <view class="group">{{ branch || "无分支" }}</view>
      <view v-for="file in files" :key="file.path" class="row" @click="project && send({ type: 'git_diff', projectId: project.id, path: file.path })">
        <text>{{ file.path }}</text>
        <text class="meta">{{ file.status }}</text>
      </view>
      <text v-if="diff" class="diff">{{ diff }}</text>
      <view class="composer">
        <textarea v-model="commitDraft" auto-height class="input" placeholder="提交说明" />
        <text class="send" @click="project && commitDraft.trim() && (send({ type: 'git_commit', projectId: project.id, message: commitDraft.trim() }), commitDraft = '')">提交</text>
      </view>
    </scroll-view>

    <scroll-view v-else-if="appTab === 'home' && homeView === 'tasks'" scroll-y class="body">
      <view class="composer">
        <textarea v-model="taskDraft" auto-height class="input" placeholder="一条待办" />
        <text class="send" @click="project && taskDraft.trim() && (send({ type: 'add_task', projectId: project.id, title: taskDraft.trim() }), taskDraft = '')">添加</text>
      </view>
      <view v-for="task in tasks" :key="task.id" class="row">
        <view>
          <text>{{ task.title }}</text>
          <text class="meta">{{ task.status }}</text>
        </view>
        <text v-if="task.status === 'todo'" class="send" @click="send({ type: 'start_task', taskId: task.id, runner: (agent?.runner || 'pi') as RunnerId })">开始</text>
      </view>
    </scroll-view>

    <view v-else-if="appTab === 'admin'" class="body column">
      <text class="who">{{ adminSession ? "当前会话 · AI管理员" : "新会话 · 发给 AI管理员" }}</text>
      <scroll-view scroll-y class="thread" :scroll-top="adminScroll">
        <view class="thread-inner">
          <template v-for="item in foldedAdmin" :key="item.id">
            <view v-if="item.kind === 'trace'" class="trace">
              <text class="trace-head" @click="toggleTrace(item.id)">{{ openTraces[item.id] ? "收起执行过程" : `执行过程 · ${item.lines.length} 条` }}</text>
              <view v-if="openTraces[item.id]" class="trace-body">
                <view v-for="(line, index) in item.lines" :key="index" class="trace-row">
                  <text v-if="line.at" class="trace-time">{{ messageTime(line.at) }}</text>
                  <text class="trace-line" user-select>{{ line.text }}</text>
                  <text class="copy" @click="copyText(line.text)">复制</text>
                </view>
              </view>
            </view>
            <view v-else class="bubble" :class="item.role" @longpress="copyText(item.text)">
              <MarkdownText :text="item.text" :tone="item.role === 'user' ? 'user' : 'agent'" />
              <view class="bubble-foot">
                <text v-if="item.at" class="when">{{ messageTime(item.at) }}</text>
                <text class="copy" @click.stop="copyText(item.text)">复制</text>
              </view>
            </view>
          </template>
          <view v-if="adminWaiting" class="bubble agent wait">
            <view class="dots">
              <view class="dot" />
              <view class="dot" />
              <view class="dot" />
            </view>
          </view>
        </view>
      </scroll-view>
      <view class="composer">
        <view class="input-wrap" @touchstart="onVoiceDown('admin', $event)" @mousedown="onVoiceDown('admin', $event)" @contextmenu.prevent>
          <textarea v-model="adminDraft" auto-height class="input" placeholder="长按这里说话" />
        </view>
        <text v-if="adminBusy && adminSession" class="stop" @touchstart.stop @mousedown.stop @click="send({ type: 'cancel', sessionId: adminSession.id })">停止</text>
        <text class="send" :class="{ off: !adminDraft.trim() }" @touchstart.stop @mousedown.stop @click="sendAdmin">发送</text>
      </view>
    </view>

    <view v-else-if="appTab === 'browser'" class="body column fill">
      <view class="tools">
        <text class="name">浏览器</text>
      </view>
      <view class="browser-actions">
        <view class="mode" :class="{ on: !browserMobile }" @click="setMobile(false)">
          <svg class="ico" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="12" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 20h8M12 16v4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <text>桌面版</text>
        </view>
        <view class="mode" :class="{ on: browserMobile }" @click="setMobile(true)">
          <svg class="ico" viewBox="0 0 24 24"><rect x="7" y="2.5" width="10" height="19" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M11 18.5h2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <text>手机版</text>
        </view>
        <view class="mode" @click="openBrowserBox('open')">
          <svg class="ico" viewBox="0 0 24 24"><path d="M14 5h5v5M19 5l-8 8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M17 13.5V18a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1h4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <text>打开</text>
        </view>
        <view class="mode" @click="openBrowserBox('type')">
          <svg class="ico" viewBox="0 0 24 24"><path d="M5 6.5h14M5 12h14M5 17.5h8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
          <text>输入</text>
        </view>
        <view class="mode" @click="openBrowserBox('port')">
          <text class="port-mark">{{ browserPort }}</text>
          <text>端口</text>
        </view>
      </view>
      <scroll-view v-if="browserTabs.length > 1" scroll-x enable-flex class="chiplist" :scroll-into-view="'tab-' + browserActiveId" scroll-with-animation>
        <view class="chiplist-row">
          <view
            v-for="(tab, index) in browserTabs"
            :id="'tab-' + tab.id"
            :key="tab.id"
            class="tab"
            :class="{ on: tab.id === browserActiveId }"
            @click="send({ type: 'browser_switch', targetId: tab.id })"
          >
            <text class="tab-index">{{ index + 1 }}</text>
            <text class="tab-title">{{ tabLabel(tab) }}</text>
          </view>
        </view>
      </scroll-view>
      <FrameView ref="browserFrame" mode="browser" hint="正在连接电脑上的浏览器" @input="onBrowserInput" />
    </view>

    <view v-else class="body column fill">
      <text class="note">按电脑屏幕实际大小显示。单指拖动画布，双指可缩小到整屏、放大到四倍。点按是左键，长按是右键，双指滑动是滚轮。</text>
      <FrameView ref="desktopFrame" mode="desktop" hint="正在连接电脑桌面" @input="send({ type: 'desktop_input', ...$event })" />
      <view class="composer slim">
        <input v-model="desktopDraft" class="input line" placeholder="输入到电脑当前焦点" />
        <text class="send" @click="submitDesktopType">输入</text>
      </view>
    </view>

    <view v-if="permission" class="permission">
      <text class="meta">Cursor 要执行</text>
      <text class="perm-title">{{ permission.title }}</text>
      <text class="meta">还剩 {{ Math.max(0, Math.ceil((permission.deadline - now) / 1000)) }} 秒，未选择会拒绝</text>
      <text v-if="permission.detail" class="diff">{{ permission.detail }}</text>
      <view v-for="change in permission.changes" :key="change.path" class="change" @click="openChange = openChange === change.path ? '' : change.path">
        <text class="link">{{ change.path }}</text>
        <text class="diff">{{ openChange === change.path ? change.diff : change.summary }}</text>
      </view>
      <view class="actions">
        <text
          v-for="option in permission.options"
          :key="option.id"
          class="chip"
          @click="send({ type: 'permission', sessionId: permission.sessionId, requestId: permission.requestId, optionId: option.id }); permission = null"
        >{{ option.name }}</text>
      </view>
    </view>

    <view v-if="showHistory || adminHistory" class="mask" @click="showHistory = false; adminHistory = false">
      <view class="sheet" @click.stop>
        <view class="sheet-head">
          <text>历史会话</text>
          <text class="link" @click="showHistory ? freshWork() : freshAdmin()">新会话</text>
        </view>
        <scroll-view scroll-y class="sheet-body">
          <view v-if="historyItems.length === 0" class="empty">还没有历史会话</view>
          <view
            v-for="item in historyItems"
            :key="item.id"
            class="row"
            @click="showHistory ? (showHistory = false, item.id !== session?.id && send({ type: 'open_session', sessionId: item.id })) : (adminHistory = false, item.id !== adminSession?.id && send({ type: 'open_session', sessionId: item.id }))"
          >
            <view>
              <text>{{ item.id === (showHistory ? session?.id : adminSession?.id) ? "当前 · " : "" }}{{ item.title || "未命名会话" }}</text>
              <text class="meta">{{ item.summary || "暂无摘要" }}</text>
            </view>
            <text class="meta">{{ formatTime(item.createdAt) }}</text>
          </view>
        </scroll-view>
      </view>
    </view>

    <view v-if="browserBox" class="mask" @click="browserBox = ''">
      <view class="prompt" @click.stop>
        <text class="prompt-title">{{ browserBox === "open" ? "打开网页" : browserBox === "port" ? "Chrome 调试端口" : "输入到网页" }}</text>
        <input v-if="browserBox === 'open'" v-model="navDraft" class="input line" placeholder="输入网址" />
        <input v-else-if="browserBox === 'port'" v-model="portDraft" class="input line" type="number" placeholder="例如 9222" />
        <textarea v-else v-model="typeDraft" class="input" auto-height placeholder="输入到网页焦点" />
        <view class="prompt-actions">
          <text class="mode" @click="browserBox = ''">取消</text>
          <text class="mode on" @click="confirmBrowserBox">确定</text>
        </view>
      </view>
    </view>

    <view v-if="copied" class="copied">已复制</view>

    <view v-if="voicePhase" class="voice-layer">
      <view class="voice-card" @click.stop>
        <view class="voice-waves" :class="{ busy: voicePhase === 'recognizing' }">
          <view v-for="bar in 7" :key="bar" class="voice-bar" />
        </view>
        <text class="voice-title">{{ voicePhase === "recording" ? "请说话" : "正在发送" }}</text>
        <text class="voice-sub">{{ voicePhase === "recording" ? "松开发送" : "请稍等" }}</text>
      </view>
    </view>

    <view class="dock">
      <text :class="{ on: appTab === 'home' }" @click="appTab = 'home'">Agent</text>
      <text :class="{ on: appTab === 'browser' }" @click="appTab = 'browser'">浏览器</text>
      <text :class="{ on: appTab === 'desktop' }" @click="appTab = 'desktop'">桌面</text>
      <text :class="{ on: appTab === 'admin' }" @click="appTab = 'admin'">AI管理员</text>
    </view>
    </template>
  </view>
</template>

<style scoped>
.screen { width: 100%; max-width: 100%; height: 100vh; display: flex; flex-direction: column; overflow-x: hidden; box-sizing: border-box; background: #f5f6f8; }
.scan-entry { padding: 16px 12px 0; }
.pair-button { display: block; padding: 12px 0; border-radius: 10px; background: #1677ff; color: #fff; text-align: center; font-size: 16px; }
.bar, .composer, .tools, .actions, .sheet-head, .tabs { display: flex; align-items: center; }
.bar { height: 48px; padding: 0 12px; background: #fff; border-bottom: 1px solid #ececec; }
.back { width: 42px; color: #1677ff; }
.title { flex: 1; text-align: center; font-weight: 600; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.top-actions { display: flex; flex-direction: row; flex-wrap: nowrap; align-items: center; gap: 8px; padding: 8px 12px; background: #fff; border-bottom: 1px solid #ececec; }
.top-actions > .top-btn,
.top-actions :deep(uni-picker),
.more-wrap { flex: 1; min-width: 0; }
.top-actions :deep(uni-picker) { width: auto; }
.top-btn { display: block; width: 100%; box-sizing: border-box; padding: 7px 8px; border-radius: 8px; background: #f2f3f5; color: #1677ff; text-align: center; font-size: 13px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.state { color: #d48806; }
.state.on { color: #389e0d; }
.alert { padding: 8px 12px; background: #fff2f0; color: #cf1322; }
.body { flex: 1; min-height: 0; }
.column { display: flex; flex-direction: column; }
.fill { overflow: hidden; }
.group { padding: 14px 16px 6px; color: #8c8c8c; font-size: 13px; }
.row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 14px 16px; background: #fff; border-bottom: 1px solid #f0f0f0; }
.project-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.project-path { word-break: break-all; }
.meta, .who, .note, .who-mini { color: #8c8c8c; font-size: 13px; }
.who, .note { display: block; padding: 8px 16px 0; }
.empty { padding: 28px 16px; text-align: center; color: #8c8c8c; }
.thread { flex: 1; width: 100%; min-height: 0; min-width: 0; box-sizing: border-box; }
.thread-inner { box-sizing: border-box; width: 100%; padding: 12px; display: flex; flex-direction: column; align-items: flex-start; }
.thread :deep(.uni-scroll-view),
.thread :deep(.uni-scroll-view-content) { width: 100%; max-width: 100%; box-sizing: border-box; }
.bubble { box-sizing: border-box; max-width: 86%; margin-bottom: 10px; padding: 10px 12px; border-radius: 14px; line-height: 1.45; word-break: break-word; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
.who-mini { display: block; -webkit-user-select: none; user-select: none; }
.bubble.user { align-self: flex-end; background: #1677ff; color: #fff; }
.bubble.agent { max-width: 100%; background: #fff; }
.bubble.wait { width: fit-content; }
.dots { display: flex; align-items: center; gap: 5px; height: 1.45em; }
.dot { width: 6px; height: 6px; border-radius: 50%; background: #8c8c8c; animation: dot-bounce 1.1s ease-in-out infinite; }
.dot:nth-child(2) { animation-delay: 0.15s; }
.dot:nth-child(3) { animation-delay: 0.3s; }
@keyframes dot-bounce {
  0%, 80%, 100% { transform: translateY(0); opacity: 0.35; }
  40% { transform: translateY(-3px); opacity: 1; }
}
.bubble-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 6px; }
.when { font-size: 11px; line-height: 1.2; opacity: 0.7; -webkit-user-select: none; user-select: none; }
.bubble .copy { font-size: 12px; line-height: 1.2; opacity: 0.8; -webkit-user-select: none; user-select: none; }
.bubble.user .copy { color: rgba(255, 255, 255, 0.88); }
.bubble.agent .copy { color: #8c8c8c; }
.trace { align-self: stretch; max-width: 100%; margin-bottom: 10px; }
.trace-head { display: block; color: #8c8c8c; font-size: 12px; text-align: center; }
.trace-body { margin-top: 6px; padding: 8px 10px; border-radius: 10px; background: #f0f1f3; }
.trace-row { display: flex; align-items: flex-start; gap: 8px; }
.trace-time { flex: none; color: #8c8c8c; font-size: 11px; line-height: 1.45; -webkit-user-select: none; user-select: none; }
.trace-row .copy { flex: none; color: #1677ff; font-size: 12px; line-height: 1.45; }
.trace-line { display: block; flex: 1; min-width: 0; color: #8c8c8c; font-size: 12px; line-height: 1.45; text-align: left; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; -webkit-user-select: text; user-select: text; }
.copied { position: fixed; left: 50%; bottom: 96px; transform: translateX(-50%); z-index: 80; padding: 8px 14px; border-radius: 999px; background: rgba(0, 0, 0, 0.72); color: #fff; font-size: 13px; }
.composer { gap: 8px; padding: 8px 12px; background: #fff; border-top: 1px solid #ececec; }
.input-wrap { position: relative; flex: 1; min-width: 0; }
.input::placeholder,
.input :deep(.uni-textarea-placeholder) { color: #bfbfbf; }
.voice-layer { position: fixed; inset: 0; z-index: 70; background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; }
.voice-card { width: 100%; padding: 28px 20px calc(168px + env(safe-area-inset-bottom)); border-radius: 20px 20px 0 0; background: #fff; display: flex; flex-direction: column; align-items: center; }
.voice-waves { display: flex; align-items: center; justify-content: center; gap: 6px; height: 72px; }
.voice-bar { width: 6px; height: 16px; border-radius: 999px; background: #1677ff; transform-origin: center; animation: voice-pulse 0.9s ease-in-out infinite; }
.voice-bar:nth-child(2),
.voice-bar:nth-child(6) { animation-delay: 0.12s; }
.voice-bar:nth-child(3),
.voice-bar:nth-child(5) { animation-delay: 0.24s; }
.voice-bar:nth-child(4) { animation-delay: 0.36s; }
.voice-waves.busy .voice-bar { animation-play-state: paused; opacity: 0.4; }
.voice-title { margin-top: 8px; font-size: 20px; font-weight: 600; }
.voice-sub { margin-top: 6px; color: #8c8c8c; font-size: 14px; }
@keyframes voice-pulse {
  0%, 100% { transform: scaleY(0.45); }
  50% { transform: scaleY(2.4); }
}
.composer.slim { border-top: 0; }
.input { flex: 1; min-width: 0; box-sizing: border-box; min-height: 36px; max-height: 96px; padding: 8px 10px; border-radius: 10px; background: #f5f6f8; }
.input-wrap .input { width: 100%; max-width: 100%; }
.input.line { height: 36px; min-height: 36px; }
.send, .chip, .link { color: #1677ff; }
.send.off { color: #bfbfbf; }
.stop { color: #cf1322; }
.more-wrap { position: relative; }
.more-mask { position: fixed; inset: 0; z-index: 40; }
.more-menu { position: absolute; top: 106px; right: 12px; z-index: 41; min-width: 148px; background: #fff; border-radius: 12px; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12); overflow: hidden; }
.more-menu text { display: block; padding: 13px 16px; border-bottom: 1px solid #f0f0f0; color: #1f1f1f; font-size: 15px; }
.tools { justify-content: space-between; padding: 8px 16px; background: #fff; }
.browser-actions { display: flex; gap: 8px; padding: 0 12px 8px; background: #fff; }
.browser-actions .mode { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 2px; min-width: 0; padding: 6px 0; font-size: 11px; line-height: 1.2; }
.ico { width: 18px; height: 18px; display: block; }
.port-mark { height: 18px; font-size: 12px; font-weight: 600; line-height: 18px; }
.prompt { width: 100%; padding: 16px; background: #fff; border-radius: 16px 16px 0 0; display: flex; flex-direction: column; gap: 12px; }
.prompt-title { font-weight: 600; }
.prompt-actions { display: flex; justify-content: flex-end; gap: 8px; }
.mode { padding: 4px 10px; border-radius: 8px; background: #f2f3f5; color: #3d3d3d; font-size: 13px; }
.mode.on { background: #1677ff; color: #fff; }
.name { font-weight: 600; }
.dock { display: flex; align-items: center; justify-content: space-around; height: 54px; background: #fff; border-top: 1px solid #ececec; }
.dock text { flex: 1; text-align: center; color: #8c8c8c; }
.dock text.on, .tab.on { color: #1677ff; font-weight: 600; }
.chiplist { width: 100%; height: 48px; background: #fff; white-space: nowrap; }
.chiplist-row { display: inline-flex; flex-direction: row; align-items: center; height: 48px; padding: 0 8px; gap: 8px; }
.tab { flex: 0 0 auto; display: flex; flex-direction: row; align-items: center; gap: 6px; max-width: 168px; height: 32px; padding: 0 10px; border-radius: 8px; background: #f2f3f5; color: #3d3d3d; }
.tab-index { flex: 0 0 auto; font-size: 12px; }
.tab-title { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; }
.tab.on { background: #1677ff; color: #fff; }
.diff { display: block; margin: 12px; white-space: pre-wrap; word-break: break-word; font-size: 12px; }
.permission { margin: 8px 12px 0; padding: 12px; border-radius: 14px; background: #fff; }
.perm-title { display: block; margin: 4px 0; font-weight: 600; }
.actions { gap: 8px; flex-wrap: wrap; margin-top: 8px; }
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.35); display: flex; align-items: flex-end; z-index: 50; }
.sheet { width: 100%; height: 72vh; background: #fff; border-radius: 16px 16px 0 0; display: flex; flex-direction: column; }
.sheet-head { justify-content: space-between; padding: 16px; }
.sheet-body { flex: 1; min-height: 0; }
</style>
