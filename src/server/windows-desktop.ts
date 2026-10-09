import { spawn, type ChildProcess } from "node:child_process";
import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";

export type ScreenBox = { width: number; height: number; x: number; y: number };

let inputChild: ChildProcess | null = null;
let inputReady: Promise<void> | null = null;

export async function ensureWindowsCapture(): Promise<string> {
  return ensureExe("desktop-capture.cs", "agentsmaster-desktop-capture.exe", ["System.Drawing.dll", "System.Windows.Forms.dll"]);
}

export async function windowsScreenSize(): Promise<ScreenBox> {
  const exe = await ensureExe("desktop-input.cs", "agentsmaster-desktop-input.exe", ["System.Drawing.dll", "System.Windows.Forms.dll"]);
  const stdout = await run(exe, ["size"]);
  const size = JSON.parse(stdout) as ScreenBox;
  if (!size.width || !size.height) throw new Error("读不到屏幕尺寸");
  return size;
}

export async function windowsScreenshot(filePath: string, region?: { x: number; y: number; width: number; height: number }) {
  const exe = await ensureWindowsCapture();
  const args = region
    ? ["shot", filePath, String(region.x), String(region.y), String(region.width), String(region.height)]
    : ["shot", filePath];
  const stdout = await run(exe, args);
  const [width, height] = stdout.trim().split(/\s+/).map(Number);
  if (!width || !height) throw new Error("截图已保存，但读不到尺寸");
  return { width, height };
}

export async function windowsInput(payload: Record<string, unknown>) {
  await ensureInput();
  if (!inputChild?.stdin?.writable) throw new Error("桌面输入没有连上");
  inputChild.stdin.write(`${JSON.stringify(payload)}\n`);
}

export async function windowsListWindows(): Promise<Array<{ appName: string; title: string }>> {
  const stdout = await powershell(`
    $rows = Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle } | ForEach-Object {
      [PSCustomObject]@{ appName = $_.ProcessName; title = $_.MainWindowTitle }
    }
    if (-not $rows) { "[]" } else { @($rows) | ConvertTo-Json -Compress }
  `);
  const parsed = JSON.parse(stdout || "[]") as { appName: string; title: string } | Array<{ appName: string; title: string }>;
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function windowsLaunch(app: string, args?: string) {
  await powershell(`
    $arg = $env:AGENTS_ARGS
    if ($arg) { Start-Process -FilePath $env:AGENTS_APP -ArgumentList $arg }
    else { Start-Process -FilePath $env:AGENTS_APP }
  `, { AGENTS_APP: app, AGENTS_ARGS: args?.trim() || "" });
  return app;
}

async function ensureInput() {
  if (inputChild && inputChild.exitCode === null && inputChild.stdin?.writable) return;
  if (!inputReady) inputReady = startInput().finally(() => { inputReady = null; });
  await inputReady;
}

async function startInput() {
  const exe = await ensureExe("desktop-input.cs", "agentsmaster-desktop-input.exe", ["System.Drawing.dll", "System.Windows.Forms.dll"]);
  const child = spawn(exe, [], { stdio: ["pipe", "ignore", "ignore"], windowsHide: true });
  child.on("exit", () => {
    if (inputChild === child) inputChild = null;
  });
  inputChild = child;
}

function ensureExe(sourceName: string, exeName: string, references: string[]) {
  const source = fileURLToPath(new URL(`./windows/${sourceName}`, import.meta.url));
  const exe = path.join(tmpdir(), exeName);
  return new Promise<string>((resolve, reject) => {
    try {
      if (statSync(exe).mtimeMs >= statSync(source).mtimeMs) {
        resolve(exe);
        return;
      }
    } catch {
      // 重新编译。
    }
    const csc = findCsc();
    let stderr = "";
    const child = spawn(csc, ["/nologo", "/optimize+", "/target:winexe", `/out:${exe}`, ...references.map((item) => `/r:${item}`), source], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-2000);
    });
    child.on("error", () => reject(new Error("这台 Windows 缺少 .NET Framework 编译器，暂时不能操作桌面")));
    child.on("close", (code) => {
      if (code === 0) resolve(exe);
      else reject(new Error(stderr.trim().split(/\r?\n/).pop() || "桌面组件没有编译成功"));
    });
  });
}

function findCsc() {
  const root = process.env.WINDIR || "C:\\Windows";
  const candidates = [
    path.join(root, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
    path.join(root, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
  ];
  const found = candidates.find((file) => {
    try {
      return statSync(file).isFile();
    } catch {
      return false;
    }
  });
  if (!found) throw new Error("这台 Windows 缺少 .NET Framework 编译器，暂时不能操作桌面");
  return found;
}

function run(command: string, args: string[]) {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(stderr.trim() || `${command} 退出 ${code}`));
    });
  });
}

function powershell(script: string, env?: Record<string, string>) {
  const wrapped = `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; $OutputEncoding = [System.Text.Encoding]::UTF8; ${script}`;
  return new Promise<string>((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-1000);
    });
    child.on("error", () => reject(new Error("这台 Windows 缺少 PowerShell")));
    child.on("close", (code) => {
      if (code === 0) resolve(stdout.trim().replace(/^\uFEFF/, ""));
      else reject(new Error(stderr.trim() || "Windows 窗口操作失败"));
    });
  });
}
