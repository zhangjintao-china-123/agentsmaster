import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = path.join(path.dirname(require.resolve("tsx/package.json")), "dist/cli.mjs");
const vite = path.join(path.dirname(require.resolve("vite/package.json")), "bin/vite.js");
const opts = { stdio: "inherit", cwd: root, env: process.env };

const server = spawn(process.execPath, [tsx, "src/server/index.ts"], opts);
const client = spawn(process.execPath, [vite], opts);

function stop() {
  server.kill("SIGTERM");
  client.kill("SIGTERM");
}

process.on("SIGINT", stop);
process.on("SIGTERM", stop);
server.on("exit", (code) => {
  if (code) process.exit(code);
});
client.on("exit", (code) => {
  if (code) process.exit(code);
});
