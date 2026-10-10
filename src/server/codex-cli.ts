import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { agentEnv } from "./cursor-cli.js";

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
