import { spawn } from "node:child_process";
import type { GitFile } from "../shared/protocol.js";

function runGit(cwd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("git", args, { cwd });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
    child.on("error", (error) => {
      resolve({ code: 1, stdout: "", stderr: error.message });
    });
  });
}

export async function gitStatus(cwd: string): Promise<{ branch: string; files: GitFile[] }> {
  const { stdout, stderr, code } = await runGit(cwd, ["status", "--porcelain=v1", "-b"]);
  if (code !== 0 && !stdout) {
    throw new Error(stderr.trim() || "git status 失败");
  }
  const lines = stdout.split("\n").filter(Boolean);
  let branch = "HEAD";
  const files: GitFile[] = [];
  for (const line of lines) {
    if (line.startsWith("##")) {
      branch = line.slice(3).split("...")[0]?.trim() || branch;
      continue;
    }
    files.push({
      status: line.slice(0, 2).trim() || "?",
      path: line.slice(3),
    });
  }
  return { branch, files };
}

export async function gitDiff(cwd: string, filePath?: string): Promise<{ path: string; diff: string }> {
  const args = filePath ? ["diff", "HEAD", "--", filePath] : ["diff", "HEAD"];
  const result = await runGit(cwd, args);
  let diff = result.stdout;
  if (!diff.trim() && filePath) {
    const untracked = await runGit(cwd, ["diff", "--no-index", "--", "/dev/null", filePath]);
    diff = untracked.stdout;
  }
  if (!diff.trim()) {
    const staged = await runGit(cwd, filePath ? ["diff", "--cached", "--", filePath] : ["diff", "--cached"]);
    diff = staged.stdout;
  }
  return { path: filePath || "", diff: diff || "没有差异" };
}

export async function gitCommit(cwd: string, message: string): Promise<{ ok: boolean; output: string }> {
  const add = await runGit(cwd, ["add", "-A"]);
  if (add.code !== 0) {
    return { ok: false, output: add.stderr || add.stdout };
  }
  const commit = await runGit(cwd, ["commit", "-m", message]);
  return {
    ok: commit.code === 0,
    output: (commit.stdout || commit.stderr).trim() || "没有可提交的变更",
  };
}
