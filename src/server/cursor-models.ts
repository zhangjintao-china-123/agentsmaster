import { spawn } from "node:child_process";
import { locateAgent } from "./cursor-cli.js";

export type CursorModel = { id: string; name: string };

let cached: { at: number; models: CursorModel[] } | null = null;

export async function listCursorModels(): Promise<CursorModel[]> {
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.models;
  const launch = locateAgent(["models"]);
  if (!launch) return [];
  const models = await readModels(launch);
  if (models.length) cached = { at: Date.now(), models };
  return models;
}

function readModels(launch: { command: string; args: string[]; env: NodeJS.ProcessEnv }): Promise<CursorModel[]> {
  return new Promise((resolve) => {
    const child = spawn(launch.command, launch.args, {
      env: launch.env,
      windowsHide: true,
    });
    let output = "";
    const finish = () => resolve(parseModels(output));
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stdout.on("error", finish);
    child.stderr.on("error", finish);
    child.on("error", finish);
    child.on("close", finish);
  });
}

function parseModels(output: string): CursorModel[] {
  const models: CursorModel[] = [];
  for (const line of output.split("\n")) {
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line.trim());
    if (!match) continue;
    const name = match[2].replace(/\s*\(current, default\)\s*$/i, "").trim();
    models.push({ id: match[1] === "auto" ? "" : match[1], name });
  }
  if (!models.some((model) => model.id === "")) models.unshift({ id: "", name: "Auto" });
  return models;
}
