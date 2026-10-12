import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv } from "./cursor-cli.js";

export function codexEnv(): NodeJS.ProcessEnv {
  const env = agentEnv();
  if (env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || env.ALL_PROXY || env.all_proxy) return env;
  const proxy = macSystemProxy();
  if (!proxy) return env;
  return { ...env, ...proxy };
}

export function locateCodex(): string | undefined {
  const configured = process.env.CODEX_BIN?.trim();
  if (configured && existsSync(configured)) return configured;
  const fromPath = commandOnPath("codex", agentEnv().PATH || "");
  if (fromPath) return fromPath;
  const fromConfig = codexCliPathFromConfig();
  if (fromConfig && existsSync(fromConfig)) return fromConfig;
  return knownCodexBins().find((candidate) => existsSync(candidate));
}

function commandOnPath(name: string, pathValue: string): string | undefined {
  const names = process.platform === "win32" ? [name, `${name}.cmd`, `${name}.exe`] : [name];
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    for (const fileName of names) {
      const candidate = path.join(dir, fileName);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

function codexCliPathFromConfig(): string | undefined {
  const file = path.join(os.homedir(), ".codex", "config.toml");
  if (!existsSync(file)) return undefined;
  try {
    const match = readFileSync(file, "utf8").match(/^\s*CODEX_CLI_PATH\s*=\s*"([^"]+)"/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

function macSystemProxy(): NodeJS.ProcessEnv | undefined {
  if (process.platform !== "darwin") return undefined;
  let text = "";
  try {
    text = execFileSync("scutil", ["--proxy"], { encoding: "utf8", timeout: 2000 });
  } catch {
    return undefined;
  }
  const http = enabledProxy(text, "HTTP");
  const https = enabledProxy(text, "HTTPS");
  const socks = enabledProxy(text, "SOCKS");
  if (!http && !https && !socks) return undefined;
  const env: NodeJS.ProcessEnv = { NO_PROXY: "localhost,127.0.0.1,::1" };
  if (http) env.HTTP_PROXY = `http://${http}`;
  if (https) env.HTTPS_PROXY = `http://${https}`;
  if (!http && !https && socks) env.ALL_PROXY = `socks5://${socks}`;
  return env;
}

function enabledProxy(text: string, kind: "HTTP" | "HTTPS" | "SOCKS"): string | undefined {
  if (!new RegExp(`^\\s*${kind}Enable\\s*:\\s*1\\s*$`, "m").test(text)) return undefined;
  const host = text.match(new RegExp(`^\\s*${kind}Proxy\\s*:\\s*(\\S+)\\s*$`, "m"))?.[1];
  const port = text.match(new RegExp(`^\\s*${kind}Port\\s*:\\s*(\\d+)\\s*$`, "m"))?.[1];
  if (!host || !port) return undefined;
  return `${host}:${port}`;
}

function knownCodexBins(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    return [
      "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex",
      path.join(home, ".codex/plugins/.plugin-appserver/codex-cli/bin/codex"),
    ];
  }
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    return [path.join(local, "OpenAI", "Codex", "codex.exe")];
  }
  return [path.join(home, ".codex/plugins/.plugin-appserver/codex-cli/bin/codex")];
}
