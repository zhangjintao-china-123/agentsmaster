import { randomUUID } from "node:crypto";
import { createReadStream, existsSync, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { transcribeSpeech } from "./asr.js";
import { acceptRelayPayload } from "../shared/relay-frame.js";

const port = Number(process.env.CLOUD_PORT || 8788);
const distDir = path.resolve("dist");
const serverIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Phone = WebSocket & { channelId: string; serverId: string };
type Frame = { id: string; event: "open" | "close" | "data"; data?: string };

const links = new Map<string, WebSocket>();
const phones = new Set<Phone>();

const server = http.createServer((req, res) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, pc: links.size > 0, pcs: links.size }));
    return;
  }
  serveStatic(url.pathname, res);
});

const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const serverId = url.searchParams.get("serverId") || "";
  if ((url.pathname !== "/ws" && url.pathname !== "/link") || !serverIdPattern.test(serverId)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    if (url.pathname === "/link") attachLink(serverId, ws);
    else attachPhone(serverId, ws as Phone);
  });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`agentsmaster cloud http://0.0.0.0:${port}`);
});

function attachLink(serverId: string, ws: WebSocket) {
  const previous = links.get(serverId);
  links.set(serverId, ws);
  keepAlive(ws);
  if (previous && previous !== ws) previous.close();
  for (const phone of phonesFor(serverId)) phone.close();
  ws.on("message", (data) => {
    let frame: Frame;
    try {
      frame = JSON.parse(String(data)) as Frame;
    } catch {
      return;
    }
    const phone = [...phones].find((item) => item.serverId === serverId && item.channelId === frame.id);
    if (phone && frame.event === "data" && frame.data !== undefined) phone.send(frame.data);
  });
  ws.on("close", () => {
    if (links.get(serverId) !== ws) return;
    links.delete(serverId);
    for (const phone of phonesFor(serverId)) phone.close();
  });
}

function attachPhone(serverId: string, ws: Phone) {
  ws.channelId = randomUUID();
  ws.serverId = serverId;
  phones.add(ws);
  keepAlive(ws);
  sendLink(serverId, { id: ws.channelId, event: "open" });
  ws.on("message", (data) => {
    const text = String(data);
    if (consumeSpeech(ws, text)) return;
    if (!acceptRelayPayload(text)) {
      ws.close(1008, "Invalid handshake key");
      return;
    }
    sendLink(serverId, { id: ws.channelId, event: "data", data: text });
  });
  ws.on("close", () => {
    phones.delete(ws);
    sendLink(serverId, { id: ws.channelId, event: "close" });
  });
}

function consumeSpeech(ws: Phone, text: string): boolean {
  if (text.length > 12_000_000) return false;
  let parsed: { type?: unknown; target?: unknown; mime?: unknown; audio?: unknown };
  try {
    parsed = JSON.parse(text) as { type?: unknown; target?: unknown; mime?: unknown; audio?: unknown };
  } catch {
    return false;
  }
  if (parsed.type !== "asr") return false;
  const target = parsed.target === "admin" ? "admin" : "work";
  const mime = typeof parsed.mime === "string" ? parsed.mime : "audio/wav";
  const audio = typeof parsed.audio === "string" ? parsed.audio : "";
  void replySpeech(ws, target, mime, audio);
  return true;
}

async function replySpeech(ws: Phone, target: "work" | "admin", mime: string, audio: string) {
  try {
    const spoken = await transcribeSpeech(audio, mime);
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "asr_text", target, text: spoken }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "语音识别失败";
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "asr_error", message }));
  }
}

function phonesFor(serverId: string) {
  return [...phones].filter((phone) => phone.serverId === serverId);
}

function sendLink(serverId: string, frame: Frame) {
  const link = links.get(serverId);
  if (link?.readyState === WebSocket.OPEN) {
    try {
      link.send(JSON.stringify(frame));
    } catch {
      link.terminate();
    }
  }
  else if (frame.event === "data") {
    const phone = [...phones].find((item) => item.serverId === serverId && item.channelId === frame.id);
    phone?.send(JSON.stringify({ type: "error", message: "电脑离线" }));
  }
}

function keepAlive(ws: WebSocket) {
  let alive = true;
  ws.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) {
      clearInterval(timer);
      return;
    }
    if (ws.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      clearInterval(timer);
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 15000);
  ws.on("close", () => clearInterval(timer));
}

function serveStatic(pathname: string, res: http.ServerResponse) {
  const raw = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  let requested = raw;
  try {
    requested = decodeURIComponent(raw);
  } catch {
    requested = raw;
  }
  const file = path.resolve(distDir, requested);
  const headers = (filePath: string): Record<string, string> => ({
    "content-type": contentType(filePath),
    "cache-control": filePath.endsWith(".html") ? "no-cache, no-store" : "public, max-age=31536000, immutable",
  });
  if (!file.startsWith(distDir) || !existsSync(file) || !statSync(file).isFile()) {
    const index = path.join(distDir, "index.html");
    if (existsSync(index)) {
      res.writeHead(200, headers(index));
      createReadStream(index).pipe(res);
      return;
    }
    res.writeHead(404);
    res.end("手机页面还没构建，在电脑上执行 npm run build");
    return;
  }
  res.writeHead(200, headers(file));
  createReadStream(file).pipe(res);
}

function contentType(file: string) {
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  return "application/octet-stream";
}
