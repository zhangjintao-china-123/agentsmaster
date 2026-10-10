import { existsSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const versionName = /^\d{4}\.\d{1,2}\.\d{1,2}(-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/i;

export function agentEnv(): NodeJS.ProcessEnv {
  const extras = [
    path.join(os.homedir(), ".local", "bin"),
    process.platform === "win32" ? path.join(process.env.LOCALAPPDATA || "", "cursor-agent") : "",
  ].filter(Boolean);
  const pathValue = process.env.PATH || "";
  const prefix = extras.filter((dir) => !pathValue.toLowerCase().includes(dir.toLowerCase()));
  return {
    ...process.env,
    PATH: prefix.length ? `${prefix.join(path.delimiter)}${path.delimiter}${pathValue}` : pathValue,
  };
}

export function resolveAgentLaunch(extraArgs: string[]): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  const env = agentEnv();
  const configured = process.env.CURSOR_AGENT_BIN?.trim();
  if (configured) {
    const fromConfig = windowsPackageFromHint(configured);
    if (fromConfig) return { command: fromConfig.node, args: [fromConfig.entry, ...extraArgs], env };
    return { command: configured, args: extraArgs, env };
  }
  const pack = resolveWindowsPackage();
  if (pack) return { command: pack.node, args: [pack.entry, ...extraArgs], env };
  return { command: process.platform === "win32" ? "agent.cmd" : "agent", args: extraArgs, env };
}

function resolveWindowsPackage(): { node: string; entry: string } | undefined {
  if (process.platform !== "win32") return undefined;
  return latestWindowsPackage(path.join(process.env.LOCALAPPDATA || "", "cursor-agent"));
}

function windowsPackageFromHint(bin: string): { node: string; entry: string } | undefined {
  if (process.platform !== "win32") return undefined;
  const resolved = path.resolve(bin);
  if (existsSync(path.join(resolved, "node.exe"))) return packageAt(resolved);
  return latestWindowsPackage(path.dirname(resolved)) ?? packageAt(path.dirname(resolved));
}

function latestWindowsPackage(root: string): { node: string; entry: string } | undefined {
  const versions = path.join(root, "versions");
  if (!existsSync(versions)) return packageAt(root);
  const names = readdirSync(versions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && versionName.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => versionKey(b) - versionKey(a));
  for (const name of names) {
    const found = packageAt(path.join(versions, name));
    if (found) return found;
  }
  return undefined;
}

function packageAt(dir: string): { node: string; entry: string } | undefined {
  const node = path.join(dir, "node.exe");
  const entry = path.join(dir, "index.js");
  if (existsSync(node) && existsSync(entry)) return { node, entry };
  return undefined;
}

function versionKey(name: string): number {
  const [year, month, day] = name.split("-")[0].split(".");
  return Number(`${year}${month.padStart(2, "0")}${day.padStart(2, "0")}`);
}
