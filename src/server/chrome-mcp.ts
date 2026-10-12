import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ChromeMcpNotice, RunnerId } from "../shared/protocol.js";
import { chromeDebugPort } from "./browser.js";
import { agentEnv } from "./cursor-cli.js";

export type McpProjectTarget = {
  id: string;
  name: string;
  path: string;
  runner: RunnerId;
};

export type McpCheckInput = {
  focus: McpProjectTarget | null;
  focusSource: "open" | "started" | "listed";
  projects: McpProjectTarget[];
  home?: string;
};

type McpEntry = {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

type Role = "open" | "started" | "listed";

type Chosen = {
  project: McpProjectTarget;
  role: Role;
  owned: boolean;
};

type OneCheck = {
  state: ChromeMcpNotice["state"];
  configuredPort?: number;
  detail: string;
  file: string;
  runner: RunnerId;
  projectPath: string;
};

const checkedRunners: RunnerId[] = ["cursor", "codex", "claude", "opencode"];

export function chromeMcpStatus(input: McpCheckInput = { focus: null, focusSource: "listed", projects: [] }): ChromeMcpNotice {
  const checks = inspectAll(input);
  return summarize(checks);
}

export function alignChromeMcp(input: McpCheckInput = { focus: null, focusSource: "listed", projects: [] }): ChromeMcpNotice {
  const home = input.home ?? os.homedir();
  for (const check of inspectAll(input)) {
    if (check.state === "aligned" || check.state === "unwritable") continue;
    const error = writeRunner(check.runner, check.projectPath, home, browserUrl(chromeDebugPort()));
    if (error) return notice("unwritable", error);
  }
  return chromeMcpStatus(input);
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

function inspectAll(input: McpCheckInput): OneCheck[] {
  const home = input.home ?? os.homedir();
  const chosen = chooseTargets(input);
  return chosen.map((item) => inspectRunner(item, home));
}

function chooseTargets(input: McpCheckInput): Chosen[] {
  const projects = input.projects.filter((project) => checkedRunners.includes(project.runner));
  const focus = input.focus && checkedRunners.includes(input.focus.runner) ? input.focus : null;
  const runners = focus ? [focus.runner, ...checkedRunners.filter((runner) => runner !== focus.runner)] : checkedRunners;
  return runners.map((runner) => {
    const own = runner === focus?.runner ? focus : projects.find((project) => project.runner === runner);
    if (own) {
      return { project: own, role: focus && own.id === focus.id ? input.focusSource : "listed", owned: true };
    }
    return {
      project: { id: `user-${runner}`, name: focus?.name ?? "", path: focus?.path ?? "", runner },
      role: "listed",
      owned: false,
    };
  });
}

function inspectRunner(chosen: Chosen, home: string): OneCheck {
  const project = chosen.project;
  const role = chosen.role;
  const expected = chromeDebugPort();
  const subject = describe(project, role, chosen.owned);
  try {
    const found = readRunner(project.runner, project.path, home);
    if (found.error) {
      return { state: "unwritable", detail: `${subject}的 MCP 配置读不了。${found.error}`, file: found.file, runner: project.runner, projectPath: project.path };
    }
    if (!found.present) {
      return { state: "missing", detail: `${subject}还没有 chrome-devtools MCP。`, file: found.file, runner: project.runner, projectPath: project.path };
    }
    if (found.port === expected) {
      return {
        state: "aligned",
        configuredPort: found.port,
        detail: `${subject}的 Chrome MCP 连的是 ${browserUrl(expected)}，和当前画面一致。`,
        file: found.file,
        runner: project.runner,
        projectPath: project.path,
      };
    }
    const where = found.port == null ? "另一个地址" : browserUrl(found.port);
    return {
      state: "mismatch",
      configuredPort: found.port,
      detail: `${subject}的 chrome-devtools 现在连的是 ${where}。`,
      file: found.file,
      runner: project.runner,
      projectPath: project.path,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "无法读取";
    return { state: "unwritable", detail: `${subject}的 MCP 配置读不了。${message}`, file: "", runner: project.runner, projectPath: project.path };
  }
}

function summarize(checks: OneCheck[]): ChromeMcpNotice {
  const port = chromeDebugPort();
  if (checks.length === 0) {
    return notice("missing", "还没有打开或启动过项目，也没有已登记的 Cursor、Codex、Claude、OpenCode 项目，无法检查 Chrome MCP。");
  }
  const detail = checks.map((check) => check.detail).join("");
  const tail = checks.every((check) => check.state === "aligned")
    ? ""
    : `手机看的是 ${browserUrl(port)}。这些 Agent 都要使用 chrome-devtools MCP，并连到这个地址。`;
  if (checks.every((check) => check.state === "aligned")) return notice("aligned", detail);
  if (checks.some((check) => check.state === "mismatch")) {
    const mismatched = checks.find((check) => check.state === "mismatch");
    return notice("mismatch", `${detail}${tail}`, mismatched?.configuredPort);
  }
  if (checks.some((check) => check.state === "missing")) return notice("missing", `${detail}${tail}`);
  return notice("unwritable", `${detail}${tail}`);
}

function describe(project: McpProjectTarget, role: Role, owned: boolean): string {
  const agent = runnerName(project.runner);
  if (role === "open") return `当前项目「${project.name}」的 ${agent}`;
  if (role === "started") return `最后启动的项目「${project.name}」的 ${agent}`;
  if (owned && project.name) return `${agent} 项目「${project.name}」`;
  return agent;
}

function runnerName(runner: RunnerId): string {
  if (runner === "cursor") return "Cursor";
  if (runner === "codex") return "Codex";
  if (runner === "claude") return "Claude";
  if (runner === "opencode") return "OpenCode";
  return "Pi";
}

type ReadResult = { file: string; present: boolean; port?: number; error?: string };

function readRunner(runner: RunnerId, projectPath: string, home: string): ReadResult {
  if (runner === "cursor") return readCursor(projectPath, home);
  if (runner === "codex") return readCodex(projectPath, home);
  if (runner === "claude") return readClaude(projectPath, home);
  if (runner === "opencode") return readOpenCode(projectPath, home);
  return { file: "", present: false, error: "这个通道不使用 Chrome MCP。" };
}

function writeRunner(runner: RunnerId, projectPath: string, home: string, url: string): string | null {
  if (runner === "cursor") return writeCursor(projectPath, home, url);
  if (runner === "codex") return writeCodex(projectPath, home, url);
  if (runner === "claude") return writeClaude(projectPath, home, url);
  if (runner === "opencode") return writeOpenCode(projectPath, home, url);
  return "这个通道不使用 Chrome MCP。";
}

function readCursor(projectPath: string, home: string): ReadResult {
  const file = cursorFile(projectPath, home);
  const config = readJsonConfig(file);
  if (config.error) return { file, present: false, error: config.error };
  const found = findChrome(config.servers);
  if (!found) return { file, present: false };
  return { file, present: true, port: found.port };
}

function writeCursor(projectPath: string, home: string, url: string): string | null {
  const file = cursorFile(projectPath, home);
  const config = readJsonConfig(file);
  if (config.error) return config.error;
  const servers = { ...config.servers };
  const found = findChrome(servers);
  if (!found) {
    const npx = locateNpx();
    if (!npx) return "这台电脑上找不到 npx，配置没法自动写进去。";
    servers["chrome-devtools"] = {
      command: npx,
      args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", url],
      env: { PATH: agentEnv().PATH || "" },
    };
  } else {
    const entry = servers[found.name];
    if (!entry || typeof entry !== "object") return "MCP 配置格式无法自动修改。";
    const record = entry as McpEntry;
    servers[found.name] = { ...record, args: withBrowserUrl(record.args ?? [], url) };
  }
  writeJson(file, { ...config.raw, mcpServers: servers });
  return null;
}

function cursorFile(projectPath: string, home: string): string {
  if (projectPath) {
    const projectFile = path.join(projectPath, ".cursor", "mcp.json");
    if (existsSync(projectFile) && fileText(projectFile).includes("chrome-devtools")) return projectFile;
  }
  return path.join(home, ".cursor", "mcp.json");
}

function readCodex(projectPath: string, home: string): ReadResult {
  const file = codexFile(projectPath, home);
  if (!existsSync(file)) return { file, present: false };
  const text = fileText(file);
  const section = codexSection(text);
  if (!section) return { file, present: false };
  return { file, present: true, port: portFromCodexSection(section) };
}

function writeCodex(projectPath: string, home: string, url: string): string | null {
  const file = codexFile(projectPath, home);
  const text = existsSync(file) ? fileText(file) : "";
  const args = `args = ["-y", "chrome-devtools-mcp@latest", "--browser-url=${url}"]`;
  const header = "[mcp_servers.chrome-devtools]";
  const start = text.indexOf(header);
  let next = text;
  if (start < 0) {
    const block = `${header}\ncommand = "npx"\n${args}\n`;
    next = `${text.trimEnd()}${text.trim() ? "\n\n" : ""}${block}`;
  } else {
    const rest = text.slice(start + header.length);
    const boundary = rest.search(/\n\[/);
    const end = boundary < 0 ? text.length : start + header.length + boundary;
    let section = text.slice(start, end);
    if (/args\s*=\s*\[[\s\S]*?\]/.test(section)) section = section.replace(/args\s*=\s*\[[\s\S]*?\]/, args);
    else section = `${section.trimEnd()}\n${args}\n`;
    next = text.slice(0, start) + section + text.slice(end);
  }
  writeText(file, next.endsWith("\n") ? next : `${next}\n`);
  return null;
}

function codexFile(projectPath: string, home: string): string {
  if (projectPath) {
    const projectFile = path.join(projectPath, ".codex", "config.toml");
    if (existsSync(projectFile) && fileText(projectFile).includes("[mcp_servers.chrome-devtools]")) return projectFile;
  }
  return path.join(home, ".codex", "config.toml");
}

function codexSection(text: string): string | null {
  const header = "[mcp_servers.chrome-devtools]";
  const start = text.indexOf(header);
  if (start < 0) return null;
  const rest = text.slice(start + header.length);
  const boundary = rest.search(/\n\[/);
  const end = boundary < 0 ? text.length : start + header.length + boundary;
  return text.slice(start, end);
}

function portFromCodexSection(section: string): number | undefined {
  const args = section.match(/args\s*=\s*(\[[\s\S]*?\])/);
  if (args) {
    try {
      const parsed = JSON.parse(args[1]) as unknown[];
      return portFromArgs(parsed.map((item) => String(item)));
    } catch {
      const inline = args[1].match(/--browser-url(?:=|\s+)(https?:\/\/[^"\s\]]+)/);
      if (inline) return portFromUrl(inline[1]);
    }
  }
  const url = section.match(/--browser-url(?:=|\s+)(https?:\/\/\S+)/);
  return url ? portFromUrl(url[1]) : undefined;
}

function readClaude(projectPath: string, home: string): ReadResult {
  const place = claudePlace(projectPath, home);
  if (!existsSync(place.file)) return { file: place.file, present: false };
  const parsed = readLooseJson(place.file);
  if (parsed.error || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { file: place.file, present: false, error: parsed.error ?? "Claude 的 MCP 配置格式无法自动修改。" };
  }
  const root = parsed.value as Record<string, unknown>;
  const servers = place.kind === "project" ? asRecord(root.mcpServers) : claudeProjectServers(root, projectPath);
  if (!servers) return { file: place.file, present: false };
  const found = findChrome(servers);
  if (!found) return { file: place.file, present: false };
  return { file: place.file, present: true, port: found.port };
}

function writeClaude(projectPath: string, home: string, url: string): string | null {
  const place = claudePlace(projectPath, home);
  if (place.kind === "project") return writeMcpServersFile(place.file, url);
  const parsed = existsSync(place.file) ? readLooseJson(place.file) : { value: {} };
  if (parsed.error || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return parsed.error ?? "Claude 的 MCP 配置格式无法自动修改。";
  }
  const root = parsed.value as Record<string, unknown>;
  const projects = asRecord(root.projects) ?? {};
  const key = matchingProjectKey(projects, projectPath) ?? path.resolve(projectPath);
  const entry = asRecord(projects[key]) ?? {};
  const servers = asRecord(entry.mcpServers) ?? {};
  const merged = mergeChromeServer(servers, url);
  if (typeof merged === "string") return merged;
  entry.mcpServers = merged;
  projects[key] = entry;
  root.projects = projects;
  writeJson(place.file, root);
  return null;
}

function claudePlace(projectPath: string, home: string): { kind: "project" | "user"; file: string } {
  if (projectPath) {
    const projectFile = path.join(projectPath, ".mcp.json");
    if (existsSync(projectFile)) return { kind: "project", file: projectFile };
  }
  return { kind: "user", file: path.join(home, ".claude.json") };
}

function claudeProjectServers(root: Record<string, unknown>, projectPath: string): Record<string, unknown> | null {
  const projects = asRecord(root.projects);
  if (!projects) return null;
  const key = matchingProjectKey(projects, projectPath);
  if (!key) return null;
  return asRecord(asRecord(projects[key])?.mcpServers);
}

function readOpenCode(projectPath: string, home: string): ReadResult {
  const file = openCodeFile(projectPath, home);
  if (!existsSync(file)) return { file, present: false };
  const parsed = readLooseJson(file);
  if (parsed.error || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { file, present: false, error: parsed.error ?? "OpenCode 的 MCP 配置格式无法自动修改。" };
  }
  const mcp = asRecord((parsed.value as Record<string, unknown>).mcp);
  if (!mcp) return { file, present: false };
  const found = findOpenCodeChrome(mcp);
  if (!found) return { file, present: false };
  return { file, present: true, port: found.port };
}

function writeOpenCode(projectPath: string, home: string, url: string): string | null {
  const file = openCodeFile(projectPath, home);
  const parsed = existsSync(file) ? readLooseJson(file) : { value: {} };
  if (parsed.error || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return parsed.error ?? "OpenCode 的 MCP 配置格式无法自动修改。";
  }
  const root = parsed.value as Record<string, unknown>;
  const mcp = asRecord(root.mcp) ?? {};
  const name = findOpenCodeChrome(mcp)?.name ?? "chrome-devtools";
  const current = asRecord(mcp[name]) ?? {};
  if (Array.isArray(current.command)) {
    current.command = withBrowserUrl(current.command.map((item) => String(item)), url);
  } else {
    const args = Array.isArray(current.args) ? current.args.map((item) => String(item)) : ["-y", "chrome-devtools-mcp@latest"];
    current.command = typeof current.command === "string" && current.command ? current.command : (locateNpx() ?? "npx");
    current.args = withBrowserUrl(args, url);
  }
  if (!current.type) current.type = "local";
  mcp[name] = current;
  root.mcp = mcp;
  writeJson(file, root);
  return null;
}

function openCodeFile(projectPath: string, home: string): string {
  if (projectPath) {
    for (const name of ["opencode.json", "opencode.jsonc"]) {
      const projectFile = path.join(projectPath, name);
      if (existsSync(projectFile) && fileText(projectFile).includes("chrome-devtools")) return projectFile;
    }
  }
  return path.join(home, ".config", "opencode", "opencode.json");
}

function findOpenCodeChrome(mcp: Record<string, unknown>): { name: string; port?: number } | undefined {
  for (const [name, value] of Object.entries(mcp)) {
    const entry = asRecord(value);
    if (!entry) continue;
    const command = Array.isArray(entry.command) ? entry.command.map((item) => String(item)) : [];
    const args = Array.isArray(entry.args) ? entry.args.map((item) => String(item)) : [];
    const hit = name === "chrome-devtools" || [...command, ...args].some((item) => item.includes("chrome-devtools-mcp"));
    if (!hit) continue;
    return { name, port: portFromArgs(command.length > 0 ? command : args) };
  }
  return undefined;
}

function writeMcpServersFile(file: string, url: string): string | null {
  const config = readJsonConfig(file);
  if (config.error) return config.error;
  const merged = mergeChromeServer(config.servers, url);
  if (typeof merged === "string") return merged;
  writeJson(file, { ...config.raw, mcpServers: merged });
  return null;
}

function mergeChromeServer(servers: Record<string, unknown>, url: string): Record<string, unknown> | string {
  const next = { ...servers };
  const found = findChrome(next);
  if (!found) {
    const npx = locateNpx();
    if (!npx) return "这台电脑上找不到 npx，配置没法自动写进去。";
    next["chrome-devtools"] = {
      command: npx,
      args: ["-y", "chrome-devtools-mcp@latest", "--browser-url", url],
    };
    return next;
  }
  const entry = next[found.name];
  if (!entry || typeof entry !== "object") return "MCP 配置格式无法自动修改。";
  const record = entry as McpEntry;
  next[found.name] = { ...record, args: withBrowserUrl(record.args ?? [], url) };
  return next;
}

function readJsonConfig(file: string): { raw: Record<string, unknown>; servers: Record<string, unknown>; error?: string } {
  if (!existsSync(file)) return { raw: {}, servers: {} };
  const parsed = readLooseJson(file);
  if (parsed.error || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return { raw: {}, servers: {}, error: parsed.error ?? "MCP 配置格式无法自动修改。" };
  }
  const raw = parsed.value as Record<string, unknown>;
  const servers = raw.mcpServers;
  if (servers != null && (typeof servers !== "object" || Array.isArray(servers))) {
    return { raw, servers: {}, error: "MCP 配置格式无法自动修改。" };
  }
  return { raw, servers: (servers ?? {}) as Record<string, unknown> };
}

function readLooseJson(file: string): { value?: unknown; error?: string } {
  try {
    const text = fileText(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/,\s*([}\]])/g, "$1");
    return { value: JSON.parse(text) };
  } catch {
    return { error: "MCP 配置不是有效的 JSON，无法自动修改。" };
  }
}

function writeJson(file: string, value: Record<string, unknown>): void {
  writeText(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file: string, text: string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode : 0o600;
  writeFileSync(file, text);
  chmodSync(file, mode);
}

function fileText(file: string): string {
  return readFileSync(file, "utf8");
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

function matchingProjectKey(projects: Record<string, unknown>, projectPath: string): string | null {
  const wanted = path.resolve(projectPath);
  for (const key of Object.keys(projects)) {
    if (path.resolve(key) === wanted) return key;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
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

function notice(state: ChromeMcpNotice["state"], detail: string, configuredPort?: number): ChromeMcpNotice {
  return configuredPort == null ? { state, port: chromeDebugPort(), detail } : { state, port: chromeDebugPort(), configuredPort, detail };
}
