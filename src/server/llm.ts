export type DeepseekLlm = {
  baseUrl: string;
  apiKey: string;
  model: "deepseek-flash";
};

export function loadDeepseekLlm(): DeepseekLlm {
  const apiKey = process.env.LLM_API_KEY || "";
  const baseUrl = (process.env.LLM_BASE_URL || "").replace(/\/$/, "");
  if (!apiKey) throw new Error("请设置 LLM_API_KEY");
  if (!baseUrl) throw new Error("请设置 LLM_BASE_URL");
  return { baseUrl, apiKey, model: "deepseek-flash" };
}

export type VisionLlm = {
  baseUrl: string;
  apiKey: string;
  model: string;
};

export function loadVisionLlm(): VisionLlm {
  const apiKey = process.env.DASHSCOPE_API_KEY || "";
  const model = process.env.VISION_MODEL || "qwen3-vl-plus";
  if (!apiKey) throw new Error("请设置 DASHSCOPE_API_KEY，才能看截图");
  const configured = process.env.DASHSCOPE_BASE_URL || "";
  const baseUrl = configured.includes("compatible-mode")
    ? configured.replace(/\/$/, "")
    : "https://dashscope.aliyuncs.com/compatible-mode/v1";
  return { baseUrl, apiKey, model };
}
