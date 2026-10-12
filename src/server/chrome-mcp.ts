import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChromeMcpNotice } from "../shared/protocol.js";
import { chromeDebugPort } from "./browser.js";
import { agentEnv } from "./cursor-cli.js";

type McpEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

const configFile = path.join(os.homedir(), ".cursor", "mcp.json");

export function chromeMcpStatus(): ChromeMcpNotice {
  return inspectConfig(readConfig(), chromeDebugPort(), locateNpx() !== undefined);
}

export function alignChromeMcp(): ChromeMcpNotice {
  const currentStatus = chromeMcpStatus();
  if (currentStatus.state === "aligned" || currentStatus.state === "unwritable") return currentStatus;
  const port = chromeDebugPort();
  const npx = locateNpx();
  const current = readConfig();
  if (current.error) return notice("unwritable", port, current.error);
  const found = findChrome(current.servers);
  if (!found && !npx) {
    return notice("unwritable", port, manual(port, "这台电脑上找不到 npx，配置没法自动写进去。"));
  }
  const url = browserUrl(port);
  const servers = { ...current.servers };
  if (!found) {
    servers["chrome-devtools"] = {
      command: npx,
      args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", url],
      env: { PATH: agentEnv().PATH || "" },
    };
  } else {
    const entry = servers[found.name];
    if (!entry || typeof entry !== "object") return notice("unwritable", port, manual(port, "Cursor 的 MCP 配置格式无法自动修改。"));
    const record = entry as McpEntry;
    servers[found.name] = { ...record, args: withBrowserUrl(record.args ?? [], url) };
  }
  writeConfig({ ...current.raw, mcpServers: servers });
  return chromeMcpStatus();
}

export function cursorSessionMcpServers(): Array<{ name: string; command: string; args: string[]; env: Array<{ name: string; value: string }> }> {
  const npx = locateNpx();
  if (!npx) return [];
  const pathValue = agentEnv().PATH || "";
  return [{
    name: "chrome-devtools",
    command: npx,
    args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", browserUrl(chromeDebugPort())],
    env: pathValue ? [{ name: "PATH", value: pathValue }] : [],
  }];
}

function readConfig(): { raw: Record<string, unknown>; servers: Record<string, unknown>; error?: string } {
  if (!existsSync(configFile)) return { raw: {}, servers: {} };
  try {
    const raw = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
    const servers = raw.mcpServers;
    if (servers != null && (typeof servers !== "object" || Array.isArray(servers))) {
      return { raw, servers: {}, error: manual(chromeDebugPort(), "Cursor 的 MCP 配置格式无法自动修改。") };
    }
    return { raw, servers: (servers ?? {}) as Record<string, unknown> };
  } catch {
    return { raw: {}, servers: {}, error: manual(chromeDebugPort(), "Cursor 的 MCP 配置不是有效的 JSON，无法自动修改。") };
  }
}

function writeConfig(value: Record<string, unknown>): void {
  mkdirSync(path.dirname(configFile), { recursive: true });
  const mode = existsSync(configFile) ? statSync(configFile).mode : 0o600;
  writeFileSync(configFile, `${JSON.stringify(value, null, 2)}\n`);
  chmodSync(configFile, mode);
}

function inspectConfig(config: ReturnType<typeof readConfig>, port: number, canWrite: boolean): ChromeMcpNotice {
  if (config.error) return notice("unwritable", port, config.error);
  const found = findChrome(config.servers);
  if (!found) {
    if (!canWrite) return notice("unwritable", port, manual(port, "这台电脑上找不到 npx，配置没法自动写进去。"));
    return notice("missing", port, rule(port, "Cursor 的配置里还没有 chrome-devtools MCP。"));
  }
  if (found.port === port) {
    return notice("aligned", port, `Agent 的 Chrome MCP 连的是 ${browserUrl(port)}，和当前画面一致。`);
  }
  return {
    state: "mismatch",
    port,
    configuredPort: found.port,
    detail: rule(port, `Cursor 里的 chrome-devtools 现在连的是 ${found.port == null ? "另一个地址" : browserUrl(found.port)}。`),
  };
}

function findChrome(servers: Record<string, unknown>): { name: string; port?: number } | undefined {
  for (const [name, value] of Object.entries(servers)) {
    if (!isChromeDevtools(name, value)) continue;
    const args = value && typeof value === "object" ? (value as McpEntry).args : undefined;
    return { name, port: portFromArgs(args) };
  }
  return undefined;
}

function isChromeDevtools(name: string, value: unknown): boolean {
  if (name === "chrome-devtools") return true;
  const args = value && typeof value === "object" ? (value as McpEntry).args : undefined;
  return Array.isArray(args) && args.some((arg) => String(arg).includes("chrome-devtools-mcp"));
}

function portFromArgs(args: unknown): number | undefined {
  if (!Array.isArray(args)) return undefined;
  const list = args.map((arg) => String(arg));
  for (let index = 0; index < list.length; index += 1) {
    const arg = list[index];
    const inline = arg.match(/^--browser-?url=(.+)$/i);
    if (inline) return portFromUrl(inline[1]);
    if (/^--browser-?url$/i.test(arg) && list[index + 1]) return portFromUrl(list[index + 1]);
  }
  return undefined;
}

function withBrowserUrl(args: string[], url: string): string[] {
  const next = [...args];
  for (let index = 0; index < next.length; index += 1) {
    if (/^--browser-?url=/i.test(next[index])) {
      next[index] = `--browser-url=${url}`;
      return next;
    }
    if (/^--browser-?url$/i.test(next[index]) && next[index + 1]) {
      next[index + 1] = url;
      return next;
    }
  }
  next.push("--browser-url", url);
  return next;
}

function portFromUrl(raw: string): number | undefined {
  try {
    const parsed = new URL(raw);
    const value = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    return Number.isInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

function locateNpx(): string | undefined {
  const configured = process.env.NPX_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  const extras = process.platform === "darwin" ? ["/opt/homebrew/bin", "/usr/local/bin"] : [];
  const pathValue = [agentEnv().PATH || "", ...extras].filter(Boolean).join(path.delimiter);
  const names = process.platform === "win32" ? ["npx.cmd", "npx.exe", "npx"] : ["npx"];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  try {
    const found = execFileSync(process.platform === "win32" ? "where" : "which", ["npx"], { encoding: "utf8" }).split(/\r?\n/)[0]?.trim();
    if (found && existsSync(found)) return found;
  } catch {
    return undefined;
  }
  return undefined;
}

function browserUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

function rule(port: number, extra: string): string {
  return `${extra}手机看的是 ${browserUrl(port)} 上的 Chrome。Agent 必须使用 chrome-devtools MCP，并连到这个地址。Cursor 自带的浏览器是另一个窗口，这里看不到。Codex、Claude、OpenCode 需要自己把 MCP 指到同一个地址。`;
}

function manual(port: number, reason: string): string {
  return `${rule(port, reason)}请手工把 --browser-url 设为 ${browserUrl(port)}。`;
}

function notice(state: ChromeMcpNotice["state"], port: number, detail: string, configuredPort?: number): ChromeMcpNotice {
  return configuredPort == null ? { state, port, detail } : { state, port, configuredPort, detail };
}
