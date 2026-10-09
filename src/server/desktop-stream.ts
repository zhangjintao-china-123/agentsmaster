import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import { logicalScreenSize } from "./desktop.js";
import { ensureWindowsCapture, windowsInput } from "./windows-desktop.js";

type Frame = { data: string; width: number; height: number };
type PointerButton = "left" | "right";

let onFrame: (frame: Frame) => void = () => {};
let capture: ChildProcess | null = null;
let captureGeneration = 0;
let starting: Promise<void> | null = null;
let helper: ChildProcess | null = null;
let helperReady: Promise<void> | null = null;
let button: PointerButton | null = null;
let frameWidth = 0;
let frameHeight = 0;
let lastEmitAt = 0;
let screenCache: { width: number; height: number; x: number; y: number; at: number } | null = null;

const swiftSource = fileURLToPath(new URL("./desktop-input.swift", import.meta.url));
const helperBin = path.join(tmpdir(), "agentsmaster-desktop-input");
const captureSource = fileURLToPath(new URL("./desktop-capture.swift", import.meta.url));
const captureBin = path.join(tmpdir(), "agentsmaster-desktop-capture");

export function setDesktopEmitters(frame: (frame: Frame) => void) {
  onFrame = frame;
}

export async function setDesktopStream(on: boolean) {
  if (!on) {
    stopCapture();
    return;
  }
  if (capture) return;
  if (!starting) starting = startCapture().finally(() => { starting = null; });
  await starting;
}

export async function desktopPointer(message:
  | { kind: "down" | "up"; x: number; y: number; button: PointerButton }
  | { kind: "move"; x: number; y: number }
  | { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { kind: "type"; text: string }) {
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("目前只支持在 Mac 或 Windows 上操作桌面");
  const screen = await screenSize();
  if (message.kind === "type") {
    await sendDesktop({ t: "text", text: message.text });
    return;
  }
  const x = (screen.x || 0) + clamp(message.x) * screen.width;
  const y = (screen.y || 0) + clamp(message.y) * screen.height;
  if (message.kind === "wheel") {
    await sendDesktop({ t: "wheel", x, y, dx: message.deltaX, dy: message.deltaY });
    return;
  }
  const b = message.kind === "move" ? (button === "right" ? 1 : 0) : (message.button === "right" ? 1 : 0);
  if (message.kind === "down") {
    button = message.button;
    await sendDesktop({ t: "down", x, y, b });
    return;
  }
  if (message.kind === "up") {
    button = null;
    await sendDesktop({ t: "up", x, y, b });
    return;
  }
  await sendDesktop({ t: button ? "drag" : "move", x, y, b });
}

async function sendDesktop(payload: Record<string, unknown>) {
  if (process.platform === "win32") {
    await windowsInput(payload);
    return;
  }
  await ensureHelper();
  writeHelper(payload);
}

async function startCapture() {
  const bin = await captureBinary();
  const screen = await screenSize();
  const denied = process.platform === "darwin"
    ? "截不了整个桌面。请到「系统设置 → 隐私与安全 → 屏幕录制」，允许运行这个服务的终端录屏，然后重新打开桌面。"
    : "截不了整个桌面。请在已登录的 Windows 桌面会话里运行这个服务，然后重新打开桌面。";
  const generation = ++captureGeneration;
  const child = spawn(bin, [], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  if (generation !== captureGeneration) {
    child.kill();
    return;
  }
  capture = child;
  let stderr = "";
  let buffer = Buffer.alloc(0);
  let gotFrame = false;
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > 8_000_000) buffer = buffer.subarray(buffer.length - 2_000_000);
    while (true) {
      const start = buffer.indexOf(Buffer.from([0xff, 0xd8]));
      if (start < 0) {
        buffer = Buffer.alloc(0);
        break;
      }
      if (start > 0) buffer = buffer.subarray(start);
      const end = buffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
      if (end < 0) break;
      const jpeg = buffer.subarray(0, end + 2);
      buffer = buffer.subarray(end + 2);
      const now = Date.now();
      if (now - lastEmitAt < 160) continue;
      lastEmitAt = now;
      const size = jpegSize(jpeg);
      if (size) {
        frameWidth = size.width;
        frameHeight = size.height;
      }
      gotFrame = true;
      onFrame({
        data: jpeg.toString("base64"),
        width: screenCache?.width || screen.width || frameWidth,
        height: screenCache?.height || screen.height || frameHeight,
      });
    }
  });
  child.on("close", () => {
    if (capture === child) capture = null;
  });
  const failed = await new Promise<string | null>((resolve) => {
    const timer = setTimeout(() => resolve(gotFrame ? null : "no-frame"), 3000);
    child.once("close", () => {
      clearTimeout(timer);
      resolve(stderr || "桌面画面没有启动");
    });
  });
  if (generation !== captureGeneration) return;
  const warmup = process.platform === "win32" ? windowsInput({ t: "ping" }) : ensureHelper();
  void warmup.catch(() => undefined);
  if (failed) {
    child.kill();
    capture = null;
    throw new Error(denied);
  }
}

async function captureBinary() {
  if (process.platform === "darwin") return ensureCaptureBin();
  if (process.platform === "win32") return ensureWindowsCapture();
  throw new Error("目前只支持在 Mac 或 Windows 上查看桌面");
}

function stopCapture() {
  captureGeneration += 1;
  capture?.kill();
  capture = null;
  button = null;
}

function ensureCaptureBin() {
  return new Promise<string>((resolve, reject) => {
    try {
      if (statSync(captureBin).mtimeMs >= statSync(captureSource).mtimeMs) {
        resolve(captureBin);
        return;
      }
    } catch {
      // 重新编译。
    }
    const compile = spawn("swiftc", ["-O", "-o", captureBin, captureSource], { stdio: "ignore" });
    compile.on("error", () => reject(new Error("这台 Mac 缺少 Swift，暂时不能查看桌面")));
    compile.on("close", (code) => {
      if (code !== 0) reject(new Error("桌面画面组件没有编译成功"));
      else resolve(captureBin);
    });
  });
}

function jpegSize(jpeg: Buffer) {
  let offset = 2;
  while (offset + 9 < jpeg.length) {
    if (jpeg[offset] !== 0xff) return null;
    const marker = jpeg[offset + 1];
    const length = jpeg.readUInt16BE(offset + 2);
    if (marker === 0xc0 || marker === 0xc2) {
      return { height: jpeg.readUInt16BE(offset + 5), width: jpeg.readUInt16BE(offset + 7) };
    }
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

async function ensureHelper() {
  if (helper && helper.stdin?.writable && helper.exitCode === null) return;
  if (!helperReady) helperReady = startHelper().finally(() => { helperReady = null; });
  await helperReady;
}

function startHelper() {
  return new Promise<void>((resolve, reject) => {
    const compile = spawn("swiftc", ["-O", "-o", helperBin, swiftSource], { stdio: "ignore" });
    compile.on("error", () => reject(new Error("这台 Mac 缺少 Swift，暂时不能操作桌面")));
    compile.on("close", (code) => {
      if (code !== 0) {
        reject(new Error("桌面输入组件没有编译成功"));
        return;
      }
      mkdirSync(path.dirname(helperBin), { recursive: true });
      const child = spawn(helperBin, [], { stdio: ["pipe", "ignore", "ignore"] });
      child.on("error", () => {
        if (helper === child) helper = null;
      });
      child.on("close", () => {
        if (helper === child) helper = null;
      });
      helper = child;
      resolve();
    });
  });
}

function writeHelper(payload: Record<string, unknown>) {
  helper?.stdin?.write(`${JSON.stringify(payload)}\n`);
}

async function screenSize() {
  if (screenCache && Date.now() - screenCache.at < 30_000) return screenCache;
  const size = await logicalScreenSize();
  screenCache = { ...size, at: Date.now() };
  return screenCache;
}

function clamp(value: number) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
