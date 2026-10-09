import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { loadVisionLlm } from "./llm.js";

const portFile = path.resolve("data/chrome-port.json");

function validPort(value: number) {
  return Number.isInteger(value) && value >= 1 && value <= 65535;
}

function loadPort() {
  try {
    const saved = Number(JSON.parse(readFileSync(portFile, "utf8")).port);
    if (validPort(saved)) return saved;
  } catch {
    // 还没在手机上改过端口。
  }
  const fromEnv = Number(process.env.CHROME_DEBUG_PORT || 9222);
  return validPort(fromEnv) ? fromEnv : 9222;
}

let port = loadPort();

export function chromeDebugPort() {
  return port;
}
const profileDir = path.join(os.homedir(), ".agentsmaster", "chrome");

type Owner = "idle" | "phone" | "agent";
type Target = { id: string; type: string; url: string; title?: string; webSocketDebuggerUrl?: string };
type TargetInfo = { targetId: string; type: string; url: string; title?: string };
type PageTab = { id: string; url: string; title: string };
type Frame = { data: string; width: number; height: number };
type Status = { open: boolean; url: string; title: string; owner: Owner; activeId: string; tabs: PageTab[]; mobile: boolean; port: number };
type Waiter = { resolve: (value: unknown) => void; reject: (error: Error) => void };
type CdpMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };

let owner: Owner = "idle";
let agentDepth = 0;
let page: WebSocket | null = null;
let browserSocket: WebSocket | null = null;
let nextId = 0;
let pending = new Map<number, Waiter>();
let browserPending = new Map<number, Waiter>();
let pages = new Map<string, PageTab>();
let knownTargets = new Set<string>();
let activeId = "";
let followNew = false;
let desiredId = "";
let focusQueued = false;
let openingSocket: Promise<void> | null = null;
let attachChain: Promise<void> = Promise.resolve();
let viewport = { width: 1, height: 1 };
let mobile = false;
let mobileSize = { width: 390, height: 844, scale: 3 };
const mobileUa = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
let currentUrl = "";
let currentTitle = "";
let screencast = false;
let wantScreencast = false;
let lastFrameAt = 0;
let burstUntil = 0;
let burstTimer: ReturnType<typeof setInterval> | null = null;
let castWatch: ReturnType<typeof setInterval> | null = null;
let castAliveAt = 0;
let scaleStable = false;
const burstMs = 10_000;
let connecting: Promise<void> | null = null;
let replacedSocket: WebSocket | null = null;
let pageSyncTimer: ReturnType<typeof setInterval> | null = null;
let syncingPages = false;
let loadWaiters: Array<() => void> = [];
let navigationArmed = false;

let onFrame: (frame: Frame) => void = () => {};
let onStatus: (status: Status) => void = () => {};

export function setBrowserEmitters(frame: (frame: Frame) => void, status: (status: Status) => void) {
  onFrame = frame;
  onStatus = status;
}

export function browserStatus(): Status {
  return {
    open: page?.readyState === WebSocket.OPEN,
    url: currentUrl,
    title: currentTitle,
    owner,
    activeId,
    tabs: [...pages.values()],
    mobile,
    port,
  };
}

export async function setChromeDebugPort(next: number): Promise<Status> {
  if (!validPort(next)) throw new Error("端口要在 1 到 65535 之间");
  if (next === port) return browserStatus();
  closeDebugger();
  port = next;
  mkdirSync(path.dirname(portFile), { recursive: true });
  writeFileSync(portFile, JSON.stringify({ port }), { mode: 0o600 });
  publish();
  if (wantScreencast) await setScreencast(true);
  return browserStatus();
}

function closeDebugger() {
  stopBurst();
  stopWatch();
  const oldPage = page;
  const oldBrowser = browserSocket;
  page = null;
  browserSocket = null;
  replacedSocket = oldPage;
  oldPage?.close();
  oldBrowser?.close();
  rejectPending(pending, "调试端口已更换");
  rejectPending(browserPending, "调试端口已更换");
  pages.clear();
  knownTargets.clear();
  activeId = "";
  desiredId = "";
  currentUrl = "";
  currentTitle = "";
  screencast = false;
  connecting = null;
  openingSocket = null;
  followNew = false;
}

export function setPhoneControl(on: boolean) {
  if (on) {
    if (owner === "agent") throw new Error("电脑上的 agent 正在操作浏览器");
    owner = "phone";
  } else if (owner === "phone") {
    owner = "idle";
  }
  publish();
  return browserStatus();
}

export async function setBrowserMobile(on: boolean, width?: number, height?: number, scale?: number) {
  if (owner === "agent") throw new Error("电脑上的 agent 正在操作浏览器");
  await ensureBrowser();
  if (on) {
    mobileSize = {
      width: clampMetric(width, 320, 520, 390),
      height: clampMetric(height, 640, 1400, 844),
      scale: clampMetric(scale, 2, 3, 3),
    };
  }
  mobile = on;
  await enqueue(async () => {
    await applyViewportMode();
    if (mobile) await request("Page.reload").catch(() => undefined);
    else {
      await request("Emulation.clearDeviceMetricsOverride").catch(() => undefined);
      await request("Emulation.setTouchEmulationEnabled", { enabled: false }).catch(() => undefined);
      await request("Emulation.setUserAgentOverride", { userAgent: "" }).catch(() => undefined);
      await request("Page.reload").catch(() => undefined);
    }
  });
  publish();
  return browserStatus();
}

async function applyViewportMode() {
  if (!mobile || !page || page.readyState !== WebSocket.OPEN) return;
  await request("Emulation.setDeviceMetricsOverride", {
    width: mobileSize.width,
    height: mobileSize.height,
    deviceScaleFactor: 1,
    mobile: true,
    screenWidth: mobileSize.width,
    screenHeight: mobileSize.height,
    screenOrientation: { type: "portraitPrimary", angle: 0 },
  });
  await request("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await request("Emulation.setUserAgentOverride", { userAgent: mobileUa, platform: "iPhone" });
}

function clampMetric(value: number | undefined, min: number, max: number, fallback: number) {
  const number = Math.round(value || fallback);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export async function ensureBrowser(): Promise<void> {
  if (page?.readyState === WebSocket.OPEN) return;
  if (!connecting) connecting = connect().finally(() => { connecting = null; });
  await connecting;
}

export async function setScreencast(on: boolean) {
  wantScreencast = on;
  if (on) {
    await ensureBrowser();
  } else {
    stopBurst();
    stopWatch();
  }
  await enqueue(async () => {
    if (!on) {
      await stopCast();
      return;
    }
    if (!page) return;
    await request("Page.bringToFront").catch(() => undefined);
    await stabilizePageScale();
    await refreshViewport();
    await startCast();
    watchCast();
  });
}

export async function switchBrowserTab(targetId: string) {
  if (owner === "agent") throw new Error("电脑上的 agent 正在操作浏览器");
  await ensureBrowser();
  if (!pages.has(targetId)) throw new Error("这个标签页已经关掉了");
  desiredId = targetId;
  if (wantScreencast) burstUntil = Date.now() + burstMs;
  await enqueue(() => activateAndAttach(targetId));
  armOperation();
}

export async function navigateBrowser(url: string) {
  await assertPhoneCanDrive();
  await ensureBrowser();
  const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  await enqueue(() => navigateAndRefresh(target));
}

export async function phoneClick(x: number, y: number) {
  await assertPhoneCanDrive();
  const held = owner === "phone";
  if (!held) owner = "phone";
  publish();
  try {
    await clickAt(x * viewport.width, y * viewport.height);
  } finally {
    armOperation();
    if (!held) {
      owner = "idle";
      publish();
    }
  }
}

export async function phoneScroll(x: number, y: number, deltaX: number, deltaY: number) {
  await assertPhoneCanDrive();
  await ensureBrowser();
  await request("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round(x * viewport.width),
    y: Math.round(y * viewport.height),
    deltaX,
    deltaY,
    pointerType: "mouse",
  });
  armOperation();
}

export async function phoneType(text: string) {
  await assertPhoneCanDrive();
  await ensureBrowser();
  await request("Input.insertText", { text });
  armOperation();
}

export async function browserState() {
  await ensureBrowser();
  return { success: true, url: currentUrl, title: currentTitle, width: viewport.width, height: viewport.height, owner };
}

export async function browserOpen(url: string) {
  return withAgent(async () => {
    await ensureBrowser();
    const target = /^https?:\/\//i.test(url) ? url : `https://${url}`;
    await enqueue(() => navigateAndRefresh(target));
    return { success: true, url: target };
  });
}

export async function browserClick(description: string) {
  return withAgent(async () => {
    const shot = await capturePng();
    const point = await locateInImage(shot.png, description, shot.width, shot.height);
    if (!point.found || point.x === undefined || point.y === undefined) {
      return { success: false, message: point.message };
    }
    await clickAt(point.x, point.y);
    armOperation();
    return { success: true, x: point.x, y: point.y, element: point.element, url: currentUrl };
  });
}

export async function browserType(text: string) {
  return withAgent(async () => {
    await ensureBrowser();
    await request("Input.insertText", { text });
    armOperation();
    return { success: true, typed: text };
  });
}

async function withAgent<T>(fn: () => Promise<T>): Promise<T> {
  if (owner === "phone") throw new Error("手机正在操作浏览器，先在手机上关掉「操作」再继续。");
  owner = "agent";
  agentDepth += 1;
  publish();
  try {
    return await fn();
  } finally {
    agentDepth -= 1;
    if (agentDepth <= 0) {
      agentDepth = 0;
      owner = "idle";
      publish();
    }
  }
}

async function assertPhoneCanDrive() {
  if (owner === "agent") throw new Error("电脑上的 agent 正在操作浏览器");
  await ensureBrowser();
}

async function connect() {
  await launchChrome();
  await openBrowserSocket();
  if (pages.size === 0) await adoptOpenPages();
  if (pages.size === 0) await createBlankPage();
  const first = [...pages.values()].at(-1);
  if (!first) throw new Error("Chrome 没有可投屏的标签页");
  followNew = true;
  desiredId = first.id;
  await enqueue(() => attachPage(first.id));
  startPageSync();
}

function startPageSync() {
  if (pageSyncTimer) return;
  pageSyncTimer = setInterval(() => {
    void syncOpenPages();
  }, 800);
  pageSyncTimer.unref();
}

async function syncOpenPages() {
  if (syncingPages) return;
  syncingPages = true;
  try {
    await syncOpenPagesBody();
  } finally {
    syncingPages = false;
  }
}

async function syncOpenPagesBody() {
  if (!browserSocket || browserSocket.readyState !== WebSocket.OPEN) {
    await openBrowserSocket().catch(() => undefined);
  }
  let listed: Target[] = [];
  try {
    listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json() as Promise<Target[]>);
  } catch {
    return;
  }
  const open = listed.filter((item) => item.id && isUsablePage({ type: item.type, url: item.url }));
  const ids = new Set(open.map((item) => item.id));
  const before = pageSignature();
  for (const item of open) {
    rememberTarget({ targetId: item.id, type: "page", url: item.url || "", title: item.title || "" });
  }
  for (const id of [...pages.keys()]) {
    if (ids.has(id)) continue;
    pages.delete(id);
    knownTargets.delete(id);
    if (id === desiredId) desiredId = "";
    if (id === activeId) {
      const next = [...pages.keys()].at(-1);
      if (next) focusPage(next);
      else {
        activeId = "";
        currentUrl = "";
        currentTitle = "";
      }
    }
  }
  if (pageSignature() !== before) publish();
  if (followNew && desiredId && desiredId !== activeId && pages.has(desiredId)) focusPage(desiredId);
}

function pageSignature() {
  return [...pages.values()].map((item) => `${item.id}\t${item.title}\t${item.url}`).join("\n");
}

async function openBrowserSocket() {
  if (browserSocket?.readyState === WebSocket.OPEN) return;
  if (!openingSocket) openingSocket = openBrowserSocketBody().finally(() => { openingSocket = null; });
  await openingSocket;
}

async function openBrowserSocketBody() {
  const version = await fetch(`http://127.0.0.1:${port}/json/version`).then((response) => response.json() as Promise<{ webSocketDebuggerUrl?: string }>);
  if (!version.webSocketDebuggerUrl) throw new Error("Chrome 没有浏览器调试地址");
  const socket = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("连不上 Chrome 调试端口"));
    }, 2000);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", () => {
      clearTimeout(timer);
      reject(new Error("连不上 Chrome 调试端口"));
    });
  });
  browserSocket = socket;
  browserPending = new Map();
  const buffered: CdpMessage[] = [];
  let primed = false;
  socket.on("message", (raw) => {
    const message = parseCdp(String(raw));
    if (!message) return;
    if (message.id && browserPending.has(message.id)) {
      settle(browserPending, message);
      return;
    }
    if (!primed) buffered.push(message);
    else applyTargetEvent(message);
  });
  socket.on("close", () => {
    if (browserSocket !== socket) return;
    browserSocket = null;
    rejectPending(browserPending, "浏览器调试连接已断开");
  });
  const listed = await browserRequest("Target.getTargets", { filter: [{}] }).catch(() => browserRequest("Target.getTargets")) as { targetInfos?: TargetInfo[] };
  const arrived = listed.targetInfos ?? [];
  const newcomers = arrived.filter((info) => info.targetId && !knownTargets.has(info.targetId));
  for (const info of arrived) rememberTarget(info, false);
  primed = true;
  for (const message of buffered) applyTargetEvent(message);
  await browserRequest("Target.setDiscoverTargets", {
    discover: true,
    filter: [{ type: "browser", exclude: true }, { type: "browser_ui", exclude: true }, {}],
  }).catch(() => browserRequest("Target.setDiscoverTargets", { discover: true }));
  const freshPage = newcomers.filter((info) => isUsablePage(info)).at(-1);
  if (followNew && freshPage) focusPage(freshPage.targetId);
}

function rememberTarget(info: TargetInfo, live = true) {
  const first = !knownTargets.has(info.targetId);
  knownTargets.add(info.targetId);
  if (info.type === "tab") {
    if (first && live && followNew) void followTab(info);
    return;
  }
  if (!isUsablePage(info)) {
    pages.delete(info.targetId);
    return;
  }
  const fresh = !pages.has(info.targetId);
  pages.set(info.targetId, { id: info.targetId, url: info.url || "", title: info.title || "" });
  if (info.targetId === activeId) {
    currentUrl = info.url || currentUrl;
    currentTitle = info.title || currentTitle;
  }
  if (fresh && live && followNew) focusPage(info.targetId);
}

function focusPage(targetId: string) {
  if (!pages.has(targetId)) return;
  desiredId = targetId;
  if (activeId === targetId && page?.readyState === WebSocket.OPEN) return;
  if (focusQueued) return;
  focusQueued = true;
  void enqueue(async () => {
    focusQueued = false;
    const goal = desiredId;
    if (!goal) return;
    await activateAndAttach(goal);
  }).catch(() => undefined);
}

async function followTab(info: TargetInfo) {
  const before = new Set(pages.keys());
  const readPages = async () => {
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json() as Promise<Target[]>);
    for (const item of listed) {
      if (!item.id || !isUsablePage({ type: item.type, url: item.url })) continue;
      rememberTarget({ targetId: item.id, type: "page", url: item.url || "", title: item.title || "" });
    }
  };
  try {
    await readPages();
    let created = [...pages.keys()].filter((id) => !before.has(id));
    if (created.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      await readPages();
      created = [...pages.keys()].filter((id) => !before.has(id));
    }
    const matched = [...pages.values()].reverse().find((item) => info.url && item.url === info.url && !before.has(item.id));
    const next = matched?.id || created.at(-1);
    if (next) focusPage(next);
  } catch {
    return;
  }
}

function applyTargetEvent(message: CdpMessage) {
  if (message.method === "Target.targetCreated" || message.method === "Target.targetInfoChanged") {
    const info = message.params?.targetInfo as TargetInfo | undefined;
    if (!info?.targetId) return;
    rememberTarget(info);
    publish();
    return;
  }
  if (message.method === "Target.targetDestroyed") {
    const targetId = String(message.params?.targetId ?? "");
    if (!targetId) return;
    knownTargets.delete(targetId);
    pages.delete(targetId);
    if (targetId === desiredId) desiredId = "";
    if (targetId === activeId) {
      const next = [...pages.keys()].at(-1);
      if (next) focusPage(next);
      else {
        activeId = "";
        currentUrl = "";
        currentTitle = "";
        publish();
      }
    } else {
      publish();
    }
  }
}

async function activateAndAttach(targetId: string) {
  if (!targetId || !pages.has(targetId)) return;
  if (activeId === targetId && page?.readyState === WebSocket.OPEN) {
    publish();
    if (wantScreencast) {
      await refreshViewport();
      await startCast();
    }
    return;
  }
  await browserRequest("Target.activateTarget", { targetId }).catch(() => undefined);
  await attachPage(targetId);
}

async function attachPage(targetId: string) {
  if (!pages.has(targetId)) return;
  if (activeId === targetId && page?.readyState === WebSocket.OPEN) {
    const info = pages.get(targetId);
    if (info) {
      currentUrl = info.url;
      currentTitle = info.title;
    }
    publish();
    if (wantScreencast) {
      await refreshViewport();
      await startCast();
    }
    return;
  }
  const resumeCast = wantScreencast;
  const old = page;
  if (old?.readyState === WebSocket.OPEN && screencast) {
    await request("Page.stopScreencast", {}).catch(() => undefined);
  }
  screencast = false;
  page = null;
  rejectPending(pending, "已切换标签页");
  replacedSocket = old;
  old?.close();
  const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${targetId}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", () => reject(new Error("连不上这个标签页")));
  });
  page = socket;
  pending = new Map();
  activeId = targetId;
  scaleStable = false;
  const info = pages.get(targetId);
  currentUrl = info?.url || "";
  currentTitle = info?.title || "";
  lastFrameAt = 0;
  socket.on("message", (raw) => onCdpMessage(String(raw)));
  socket.on("close", () => {
    if (replacedSocket === socket) {
      replacedSocket = null;
      return;
    }
    if (page !== socket) return;
    page = null;
    screencast = false;
    rejectPending(pending, "浏览器标签已断开");
    publish();
    const next = [...pages.keys()].reverse().find((id) => id !== targetId);
    if (next) void enqueue(() => attachPage(next));
  });
  await request("Page.enable");
  await request("Runtime.enable");
  await applyViewportMode();
  await refreshViewport();
  publish();
  await request("Page.bringToFront").catch(() => undefined);
  if (resumeCast) await startCast();
}

function enqueue(fn: () => Promise<void>) {
  const run = attachChain.then(fn, fn);
  attachChain = run.then(() => undefined, () => undefined);
  return run;
}

function chromeBinary() {
  const local = process.env.LOCALAPPDATA;
  const candidates = process.platform === "win32"
    ? [
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      local ? path.join(local, "Google", "Chrome", "Application", "chrome.exe") : "",
    ]
    : ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"];
  const found = candidates.find((file) => file && existsSync(file));
  if (found) return found;
  if (process.platform === "win32") throw new Error("Chrome 没有安装。请在这台 Windows 上安装 Google Chrome。");
  if (process.platform === "darwin") throw new Error("Chrome 没有安装。请确认这台 Mac 安装了 Google Chrome。");
  throw new Error("目前只支持在 Mac 或 Windows 上打开受控浏览器");
}

async function launchChrome() {
  if (await debuggerUp()) return;
  const binary = chromeBinary();
  mkdirSync(profileDir, { recursive: true });
  const child = spawn(binary, [
    `--remote-debugging-port=${port}`,
    "--remote-debugging-address=127.0.0.1",
    `--user-data-dir=${profileDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => undefined);
  child.unref();
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (await debuggerUp()) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(process.platform === "win32"
    ? "Chrome 没有启动。请确认这台 Windows 安装了 Google Chrome。"
    : "Chrome 没有启动。请确认这台 Mac 安装了 Google Chrome。");
}

async function debuggerUp() {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(400) });
    return response.ok;
  } catch {
    return false;
  }
}

async function adoptOpenPages() {
  try {
    const listed = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) }).then((response) => response.json() as Promise<Target[]>);
    for (const item of listed) {
      if (!item.id || !isUsablePage({ type: item.type, url: item.url })) continue;
      rememberTarget({ targetId: item.id, type: "page", url: item.url || "", title: item.title || "" }, false);
    }
  } catch {
    return;
  }
}

async function createBlankPage() {
  const created = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const response = created.ok ? created : await fetch(`http://127.0.0.1:${port}/json/new?about:blank`);
  if (!response.ok) throw new Error("Chrome 没有可投屏的标签页");
  const target = await response.json() as Target;
  if (!target.id) throw new Error("Chrome 没有返回调试地址");
  rememberTarget({ targetId: target.id, type: "page", url: target.url || "about:blank", title: target.title || "" });
}

function isUsablePage(info: { type?: string; url?: string }) {
  if (info.type !== "page") return false;
  const url = info.url || "";
  if (url.startsWith("devtools://") || url.startsWith("chrome-extension://") || url.startsWith("chrome-untrusted://")) return false;
  return true;
}

function parseCdp(raw: string): CdpMessage | null {
  try {
    return JSON.parse(raw) as CdpMessage;
  } catch {
    return null;
  }
}

function settle(waiters: Map<number, Waiter>, message: CdpMessage) {
  if (!message.id || !waiters.has(message.id)) return;
  const waiter = waiters.get(message.id)!;
  waiters.delete(message.id);
  if (message.error) waiter.reject(new Error(message.error.message || "浏览器命令失败"));
  else waiter.resolve(message.result);
}

function rejectPending(waiters: Map<number, Waiter>, message: string) {
  for (const waiter of waiters.values()) waiter.reject(new Error(message));
  waiters.clear();
}

function onCdpMessage(raw: string) {
  const message = parseCdp(raw);
  if (!message) return;
  if (message.id && pending.has(message.id)) {
    settle(pending, message);
    return;
  }
  if (message.method === "Page.screencastFrame") {
    const params = message.params ?? {};
    const data = String(params.data ?? "");
    const sessionId = params.sessionId;
    const meta = params.metadata as { deviceWidth?: number; deviceHeight?: number; pageScaleFactor?: number } | undefined;
    if (meta?.deviceWidth && meta.deviceHeight) viewport = { width: meta.deviceWidth, height: meta.deviceHeight };
    if (typeof sessionId === "number") void request("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
    const now = Date.now();
    if (data && now - lastFrameAt >= 200) {
      lastFrameAt = now;
      castAliveAt = now;
      const remain = Math.max(0, burstUntil - now);
      console.log(`[画面] 帧 ${viewport.width}x${viewport.height} 页面缩放 ${meta?.pageScaleFactor ?? ""} ${data.length}字符 剩余${Math.round(remain / 1000)}秒`);
      onFrame({ data, width: viewport.width, height: viewport.height });
      if (now >= burstUntil) {
        void enqueue(async () => {
          if (Date.now() < burstUntil) return;
          await stopCast();
        });
      }
    }
  }
  if (message.method === "Page.windowOpen") {
    void syncOpenPages();
    setTimeout(() => void syncOpenPages(), 250);
    setTimeout(() => void syncOpenPages(), 700);
  }
  if (message.method === "Page.frameNavigated") {
    const frame = (message.params?.frame ?? {}) as { url?: string; parentId?: string };
    if (!frame.parentId && frame.url) {
      currentUrl = frame.url;
      navigationArmed = true;
      publish();
    }
  }
  if (message.method === "Page.loadEventFired" && navigationArmed) releaseLoadWaiters();
}

async function navigateAndRefresh(target: string) {
  const loaded = waitForMainLoad();
  const result = await request("Page.navigate", { url: target }) as { errorText?: string };
  if (result?.errorText) {
    releaseLoadWaiters();
    throw new Error(result.errorText);
  }
  currentUrl = target;
  publish();
  armOperation();
  await loaded;
}

function waitForMainLoad() {
  navigationArmed = false;
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, 4000);
    function finish() {
      clearTimeout(timer);
      loadWaiters = loadWaiters.filter((item) => item !== finish);
      resolve();
    }
    loadWaiters.push(finish);
  });
}

function releaseLoadWaiters() {
  const waiters = loadWaiters;
  loadWaiters = [];
  for (const waiter of waiters) waiter();
}

function armOperation() {
  if (!wantScreencast) return;
  burstUntil = Date.now() + burstMs;
  if (!burstTimer) {
    burstTimer = setInterval(() => {
      if (!wantScreencast || Date.now() >= burstUntil) {
        stopBurst();
        void enqueue(async () => {
          if (wantScreencast && Date.now() < burstUntil) return;
          await stopCast();
        });
      }
    }, 400);
    burstTimer.unref();
  }
  void enqueue(async () => {
    if (!wantScreencast || !page || page.readyState !== WebSocket.OPEN) return;
    await stabilizePageScale();
    await refreshViewport();
    if (screencast) await stopCast();
    await startCast();
  });
  watchCast();
}

function stopBurst() {
  if (burstTimer) clearInterval(burstTimer);
  burstTimer = null;
}

function stopWatch() {
  if (castWatch) clearInterval(castWatch);
  castWatch = null;
}

function watchCast() {
  if (castWatch) return;
  castWatch = setInterval(() => {
    if (!wantScreencast) {
      stopWatch();
      return;
    }
    const bursting = Date.now() < burstUntil;
    const alive = Math.max(lastFrameAt, castAliveAt);
    const stalled = !alive || Date.now() - alive >= 400;
    if (!bursting) {
      if (lastFrameAt) {
        if (screencast) {
          void enqueue(async () => {
            if (Date.now() < burstUntil) return;
            await stopCast();
          });
        }
        return;
      }
      if (screencast && alive && Date.now() - alive < 2000) return;
    } else if (screencast && !stalled) return;
    void enqueue(async () => {
      if (!wantScreencast || !page || page.readyState !== WebSocket.OPEN) return;
      if (Date.now() >= burstUntil && lastFrameAt) {
        await stopCast();
        return;
      }
      const recent = Math.max(lastFrameAt, castAliveAt);
      const wait = Date.now() < burstUntil ? 400 : 2000;
      if (screencast && recent && Date.now() - recent < wait) return;
      if (screencast) await stopCast();
      await startCast();
    });
  }, 400);
  castWatch.unref();
}

async function startCast() {
  if (!page || page.readyState !== WebSocket.OPEN || screencast) return;
  lastFrameAt = 0;
  await request("Page.startScreencast", { format: "jpeg", quality: 80, everyNthFrame: 1 });
  screencast = true;
  castAliveAt = Date.now();
  console.log(`[画面] 开始投屏 ${viewport.width}x${viewport.height}`);
}

async function stopCast() {
  const was = screencast;
  if (page?.readyState === WebSocket.OPEN && screencast) {
    await request("Page.stopScreencast", {}).catch(() => undefined);
  }
  screencast = false;
  if (was) console.log("[画面] 停止投屏");
}

async function stabilizePageScale() {
  if (scaleStable || !page || page.readyState !== WebSocket.OPEN) return;
  const metrics = await request("Page.getLayoutMetrics") as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const visual = metrics.cssVisualViewport;
  const layout = metrics.cssLayoutViewport;
  const result = await request("Runtime.evaluate", {
    expression: "devicePixelRatio",
    returnByValue: true,
  }) as { result?: { value?: number } };
  const ratio = result.result?.value ?? 1;
  const visualWidth = visual?.clientWidth ?? 0;
  const visualHeight = visual?.clientHeight ?? 0;
  const layoutWidth = layout?.clientWidth ?? visualWidth;
  const split = visualWidth > 0 && (layoutWidth > visualWidth * 1.4 || (visualWidth <= 520 && ratio > 1));
  scaleStable = true;
  if (!split) return;
  mobile = true;
  mobileSize = { width: Math.round(visualWidth), height: Math.round(visualHeight), scale: 1 };
  await applyViewportMode();
}

async function refreshViewport() {
  const metrics = await request("Page.getLayoutMetrics") as {
    cssVisualViewport?: { clientWidth?: number; clientHeight?: number };
    cssLayoutViewport?: { clientWidth?: number; clientHeight?: number };
  };
  const visual = metrics.cssVisualViewport;
  const layout = metrics.cssLayoutViewport;
  const box = visual?.clientWidth && visual.clientHeight ? visual : layout;
  if (box?.clientWidth && box.clientHeight) viewport = { width: box.clientWidth, height: box.clientHeight };
}

function request(method: string, params: unknown = {}): Promise<unknown> {
  return command(page, pending, method, params);
}

function browserRequest(method: string, params: unknown = {}): Promise<unknown> {
  return command(browserSocket, browserPending, method, params);
}

function command(socket: WebSocket | null, waiters: Map<number, Waiter>, method: string, params: unknown): Promise<unknown> {
  if (!socket || socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error("浏览器还没连上"));
  const id = ++nextId;
  let settleWaiter: Waiter;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!waiters.has(id)) return;
      waiters.delete(id);
      reject(new Error("浏览器没有响应"));
    }, 8000);
    settleWaiter = {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    waiters.set(id, settleWaiter);
  });
  socket.send(JSON.stringify({ id, method, params }));
  return promise;
}

async function clickAt(x: number, y: number) {
  await ensureBrowser();
  const point = { x: Math.round(x), y: Math.round(y), button: "left", clickCount: 1 };
  try {
    await request("Input.dispatchMouseEvent", { ...point, type: "mousePressed" });
    await request("Input.dispatchMouseEvent", { ...point, type: "mouseReleased" });
  } catch (error) {
    if (error instanceof Error && error.message === "已切换标签页") return;
    throw error;
  }
}

async function capturePng() {
  await ensureBrowser();
  const shot = await request("Page.captureScreenshot", { format: "png" }) as { data?: string };
  if (!shot.data) throw new Error("浏览器没有返回截图");
  const png = Buffer.from(shot.data, "base64");
  const file = path.join(os.tmpdir(), "agentsmaster-computer-use", `browser_${Date.now()}.png`);
  mkdirSync(path.dirname(file), { recursive: true });
  await writeFile(file, png);
  return { png, file, width: viewport.width, height: viewport.height };
}

async function locateInImage(png: Buffer, description: string, width: number, height: number) {
  const vision = loadVisionLlm();
  const response = await fetch(`${vision.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${vision.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: vision.model,
      messages: [{
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${png.toString("base64")}` } },
          {
            type: "text",
            text: `请在图片中找到：${description}\n坐标使用图片内的虚拟坐标系，宽高都归一化到 0~1000。只返回 JSON。\n找到时：{"found": true, "x1": 0, "y1": 0, "x2": 10, "y2": 10, "element": "简短描述"}\n找不到时：{"found": false, "element": "原因"}`,
          },
        ],
      }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) return { found: false, message: `视觉模型调用失败（HTTP ${response.status}）` };
  const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = body.choices?.[0]?.message?.content?.trim() ?? "";
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) return { found: false, message: `模型返回无法解析：${raw.slice(0, 200)}` };
  const parsed = JSON.parse(jsonText) as { found?: boolean; element?: string; x1?: number; y1?: number; x2?: number; y2?: number };
  if (!parsed.found || parsed.x1 === undefined || parsed.y1 === undefined || parsed.x2 === undefined || parsed.y2 === undefined) {
    return { found: false, message: `未找到「${description}」：${parsed.element ?? "模型没说明原因"}` };
  }
  const x = ((parsed.x1 + parsed.x2) / 2 / 1000) * width;
  const y = ((parsed.y1 + parsed.y2) / 2 / 1000) * height;
  return { found: true, x, y, element: parsed.element };
}

function publish() {
  onStatus(browserStatus());
}
