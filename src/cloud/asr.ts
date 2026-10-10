const endpoint = "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
const model = "qwen3-asr-flash";

export async function transcribeSpeech(audio: string, mime: string): Promise<string> {
  if (!audio || audio.length < 100) throw new Error("录音太短");
  if (audio.length > 12_000_000) throw new Error("录音太长");
  const apiKey = process.env.DASHSCOPE_API_KEY || "";
  if (!apiKey) throw new Error("语音识别没有配置密钥");
  const kind = mime.includes("wav") ? "wav" : mime.includes("webm") ? "webm" : mime.includes("mp4") ? "mp4" : "wav";
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [{ audio: `data:audio/${kind};base64,${audio}` }],
          },
        ],
      },
      parameters: {
        asr_options: {
          language: "zh",
          enable_itn: true,
        },
      },
    }),
  });
  const body = (await response.json().catch(() => null)) as {
    message?: string;
    output?: { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }> };
  } | null;
  if (!response.ok) throw new Error(body?.message || "语音识别失败");
  const content = body?.output?.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content : Array.isArray(content) ? content.map((item) => item.text || "").join("") : "";
  const spoken = text.trim();
  if (!spoken) throw new Error("没有识别到文字");
  return spoken;
}
