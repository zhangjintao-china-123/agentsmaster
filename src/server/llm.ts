import { readFileSync } from "node:fs";

const localPath = "/Users/zhangjintao/code/pptgen/config/config.local.toml";
const basePath = "/Users/zhangjintao/code/pptgen/config/config.toml";

export type DeepseekLlm = {
  baseUrl: string;
  apiKey: string;
  model: "deepseek-flash";
};

export function loadDeepseekLlm(): DeepseekLlm {
  const base = readSection(basePath, "llm");
  const local = readSection(localPath, "llm");
  const apiKey = local.api_key || base.api_key;
  const baseUrl = local.base_url || base.base_url;
  if (!apiKey) throw new Error("pptgen [llm] 没有 api_key");
  if (!baseUrl) throw new Error("pptgen [llm] 没有 base_url");
  return { baseUrl, apiKey, model: "deepseek-flash" };
}

export type VisionLlm = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function loadVisionLlm(): VisionLlm {
  const base = readSection(basePath, "dashscope");
  const local = readSection(localPath, "dashscope");
  const apiKey = local.api_key || base.api_key;
  const model = local.model || base.model || "qwen3-vl-plus";
  if (!apiKey) throw new Error("pptgen [dashscope] 没有 api_key，无法看截图");
  const configured = local.base_url || base.base_url || "";
  const baseUrl = configured.includes("compatible-mode")
    ? configured.replace(/\/$/, "")
    : "https://dashscope.aliyuncs.com/compatible-mode/v1";
  return { baseUrl, apiKey, model };
}

function readSection(file: string, name: string): Record<string, string> {
  const text = readFileSync(file, "utf8");
  const body = text.split(/\n(?=\[[^\]]+\])/).find((part) => part.startsWith(`[${name}]`));
  const values: Record<string, string> = {};
  if (!body) return values;
  for (const line of body.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("[")) break;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    values[key] = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^"|"$/g, "");
  }
  return values;
}
