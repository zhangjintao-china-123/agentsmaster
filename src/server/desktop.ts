import { execFile, spawn } from "node:child_process";
import { mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { windowsInput, windowsLaunch, windowsListWindows, windowsScreenSize, windowsScreenshot } from "./windows-desktop.js";

const execFileAsync = promisify(execFile);

function copyToClipboard(text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("pbcopy");
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error("复制到剪贴板失败"));
    });
    child.stdin.end(text);
  });
}
const shotDir = join(tmpdir(), "agentsmaster-computer-use");

export type Shot = {
  filePath: string;
  width: number;
  height: number;
  region?: { x: number; y: number; width: number; height: number };
};

export function parseRegion(region?: string): { x: number; y: number; width: number; height: number } | undefined {
  if (!region?.trim()) return undefined;
  const parts = region.split(",").map((part) => Number(part.trim()));
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    throw new Error("region 格式应为 x,y,width,height");
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) throw new Error("region 的宽高必须大于 0");
  return { x, y, width, height };
}

export async function takeScreenshot(region?: string): Promise<Shot> {
  if (process.platform !== "darwin" && process.platform !== "win32") throw new Error("目前只支持在 Mac 或 Windows 上操作这台电脑");
  const box = parseRegion(region);
  if (process.platform === "win32") {
    await mkdir(shotDir, { recursive: true });
    const filePath = join(shotDir, `screenshot_${Date.now()}.png`);
    const size = await windowsScreenshot(filePath, box);
    return { filePath, width: size.width, height: size.height, region: box };
  }
  await mkdir(shotDir, { recursive: true });
  const filePath = join(shotDir, `screenshot_${Date.now()}.png`);
  const args = ["-x", filePath];
  if (box) args.unshift("-R", `${box.x},${box.y},${box.width},${box.height}`);
  try {
    await execFileAsync("screencapture", args, { timeout: 15_000 });
  } catch (error) {
    const detail = error instanceof Error ? error.message : "";
    if (detail.includes("could not create image")) {
      throw new Error("截不了屏。请到「系统设置 → 隐私与安全 → 屏幕录制」，允许运行这个服务的终端录屏，然后重启服务。");
    }
    throw error;
  }
  await execFileAsync("sips", ["-Z", "1080", filePath], { timeout: 15_000 });
  const info = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", filePath], { timeout: 10_000 });
  const width = Number(/pixelWidth:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0);
  const height = Number(/pixelHeight:\s*(\d+)/.exec(info.stdout)?.[1] ?? 0);
  if (!width || !height) throw new Error("截图已保存，但读不到尺寸");
  return { filePath, width, height, region: box };
}

export async function logicalScreenSize(): Promise<{ width: number; height: number; x: number; y: number }> {
  if (process.platform === "win32") return windowsScreenSize();
  if (process.platform !== "darwin") throw new Error("目前只支持在 Mac 或 Windows 上操作这台电脑");
  const script = `
    ObjC.import("AppKit");
    const frame = $.NSScreen.mainScreen.frame;
    JSON.stringify({ width: frame.size.width, height: frame.size.height });
  `;
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000 });
  const size = JSON.parse(stdout) as { width: number; height: number };
  if (!size.width || !size.height) throw new Error("读不到屏幕尺寸");
  return { width: size.width, height: size.height, x: 0, y: 0 };
}

export function qwenToScreen(
  qwenX: number,
  qwenY: number,
  shot: Shot,
  screen: { width: number; height: number; x: number; y: number },
): { x: number; y: number } {
  const spanW = shot.region?.width ?? screen.width;
  const spanH = shot.region?.height ?? screen.height;
  const originX = shot.region?.x ?? screen.x;
  const originY = shot.region?.y ?? screen.y;
  const x = Math.round((qwenX / 1000) * spanW + originX);
  const y = Math.round((qwenY / 1000) * spanH + originY);
  return {
    x: Math.max(screen.x, Math.min(x, screen.x + screen.width - 1)),
    y: Math.max(screen.y, Math.min(y, screen.y + screen.height - 1)),
  };
}

async function postMouse(kind: "move" | "down" | "up", x: number, y: number, button: "left" | "right" | "middle") {
  if (process.platform === "win32") {
    const b = button === "right" ? 1 : button === "middle" ? 2 : 0;
    await windowsInput({ t: kind === "move" ? "move" : kind, x, y, b });
    return;
  }
  const type = kind === "move" ? 5 : kind === "down"
    ? button === "right" ? 3 : button === "middle" ? 25 : 1
    : button === "right" ? 4 : button === "middle" ? 26 : 2;
  const cgButton = button === "right" ? 1 : button === "middle" ? 2 : 0;
  const script = `
    ObjC.import("CoreGraphics");
    const point = $.CGPointMake(${x}, ${y});
    const event = $.CGEventCreateMouseEvent(null, ${type}, point, ${cgButton});
    $.CGEventPost(0, event);
  `;
  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000 });
}

export async function moveMouse(x: number, y: number) {
  const screen = await logicalScreenSize();
  const point = {
    x: Math.max(screen.x, Math.min(Math.round(x), screen.x + screen.width - 1)),
    y: Math.max(screen.y, Math.min(Math.round(y), screen.y + screen.height - 1)),
  };
  await postMouse("move", point.x, point.y, "left");
  return point;
}

export async function clickMouse(
  x: number,
  y: number,
  button: "left" | "right" | "middle" = "left",
  clicks = 1,
) {
  const point = await moveMouse(x, y);
  const times = Math.max(1, Math.min(Math.round(clicks), 3));
  for (let i = 0; i < times; i += 1) {
    await postMouse("down", point.x, point.y, button);
    await postMouse("up", point.x, point.y, button);
    if (i + 1 < times) await waitSeconds(0.12);
  }
  return { ...point, button, clicks: times };
}

const KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  escape: 53,
  esc: 53,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 117,
  up: 126,
  down: 125,
  left: 123,
  right: 124,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

export async function pressKey(key: string) {
  const name = key.trim().toLowerCase();
  if (process.platform === "win32") {
    await windowsInput({ t: "key", text: name });
    return name;
  }
  const code = KEY_CODES[name];
  const script = code
    ? `ObjC.import("CoreGraphics");
       const down = $.CGEventCreateKeyboardEvent(null, ${code}, true);
       const up = $.CGEventCreateKeyboardEvent(null, ${code}, false);
       $.CGEventPost(0, down); $.CGEventPost(0, up);`
    : `tell application "System Events" to keystroke ${JSON.stringify(name.slice(0, 1))}`;
  const args = code ? ["-l", "JavaScript", "-e", script] : ["-e", script];
  await execFileAsync("osascript", args, { timeout: 10_000 });
  return name;
}

const MODIFIERS: Record<string, string> = {
  command: "command down",
  cmd: "command down",
  option: "option down",
  alt: "option down",
  control: "control down",
  ctrl: "control down",
  shift: "shift down",
};

export async function pressHotkey(keys: string[]) {
  const names = keys.map((key) => key.trim().toLowerCase()).filter(Boolean);
  if (names.length < 2) throw new Error("组合键至少要两个键，例如 command 和 c");
  const letter = names.find((key) => !MODIFIERS[key] && !KEY_CODES[key]);
  const special = names.find((key) => KEY_CODES[key] && !MODIFIERS[key]);
  const flags = names.filter((key) => MODIFIERS[key]).map((key) => MODIFIERS[key]);
  const hasModifier = names.some((key) => MODIFIERS[key] || (process.platform === "win32" && (key === "win" || key === "meta")));
  if (!hasModifier) throw new Error("组合键里需要 command、option、control、shift 或 win");
  if (process.platform === "win32") {
    const mapped = names.map((key) => (key === "command" || key === "cmd" ? "ctrl" : key === "option" ? "alt" : key));
    await windowsInput({ t: "hotkey", text: mapped.join("+") });
    return names;
  }
  if (letter) {
    const script = `tell application "System Events" to keystroke ${JSON.stringify(letter.slice(0, 1))} using {${flags.join(", ")}}`;
    await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
    return names;
  }
  if (!special) throw new Error("这个组合键暂时只支持修饰键加一个字母或功能键");
  const code = KEY_CODES[special];
  const flagMask = names.reduce((mask, key) => {
    if (key === "command" || key === "cmd") return mask | 0x100000;
    if (key === "shift") return mask | 0x20000;
    if (key === "option" || key === "alt") return mask | 0x80000;
    if (key === "control" || key === "ctrl") return mask | 0x40000;
    return mask;
  }, 0);
  const script = `
    ObjC.import("CoreGraphics");
    const down = $.CGEventCreateKeyboardEvent(null, ${code}, true);
    const up = $.CGEventCreateKeyboardEvent(null, ${code}, false);
    $.CGEventSetFlags(down, ${flagMask});
    $.CGEventSetFlags(up, ${flagMask});
    $.CGEventPost(0, down); $.CGEventPost(0, up);
  `;
  await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 10_000 });
  return names;
}

export async function typeText(text: string) {
  if (!text) throw new Error("没有要输入的文字");
  if (process.platform === "win32") {
    await windowsInput({ t: "text", text });
    return "keystroke";
  }
  const nonAscii = [...text].some((char) => char.charCodeAt(0) > 127);
  if (nonAscii || text.length > 40) {
    await copyToClipboard(text);
    await pressHotkey(["command", "v"]);
    return "clipboard";
  }
  const script = `tell application "System Events" to keystroke ${JSON.stringify(text)}`;
  await execFileAsync("osascript", ["-e", script], { timeout: 20_000 });
  return "keystroke";
}

export async function launchApplication(app: string, args?: string) {
  if (process.platform === "win32") return windowsLaunch(app, args);
  const command = ["-a", app];
  if (args?.trim()) command.push("--args", ...args.trim().split(/\s+/));
  await execFileAsync("open", command, { timeout: 15_000 });
  return app;
}

export async function listWindows(): Promise<Array<{ appName: string; title: string }>> {
  if (process.platform === "win32") return windowsListWindows();
  const script = `
    const system = Application("System Events");
    const rows = [];
    for (const process of system.processes.whose({ backgroundOnly: false })()) {
      const appName = process.name();
      let titles = [];
      try { titles = process.windows.name(); } catch (error) { titles = []; }
      if (!titles.length) rows.push({ appName, title: "" });
      for (const title of titles) rows.push({ appName, title: title || "" });
    }
    JSON.stringify(rows);
  `;
  const { stdout } = await execFileAsync("osascript", ["-l", "JavaScript", "-e", script], { timeout: 15_000 });
  return JSON.parse(stdout) as Array<{ appName: string; title: string }>;
}

export async function focusWindow(title: string) {
  const windows = await listWindows();
  const needle = title.trim().toLowerCase();
  const match = windows.find((window) =>
    window.appName.toLowerCase().includes(needle) || window.title.toLowerCase().includes(needle));
  if (!match) throw new Error(`没找到包含「${title}」的窗口。先用 list_windows 看现在开着哪些应用`);
  if (process.platform === "win32") {
    await windowsInput({ t: "focus", text: match.title || match.appName });
    return match;
  }
  const script = `tell application ${JSON.stringify(match.appName)} to activate`;
  await execFileAsync("osascript", ["-e", script], { timeout: 10_000 });
  return match;
}

export async function waitSeconds(seconds: number) {
  const waited = Math.max(0.1, Math.min(seconds, 30));
  await new Promise((resolve) => setTimeout(resolve, waited * 1000));
  return waited;
}

export async function readPng(filePath: string): Promise<Buffer> {
  return readFile(filePath);
}
