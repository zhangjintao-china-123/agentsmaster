import WebSocket from "ws";
import { openBox, seal } from "../shared/e2ee.js";
import { decodeKey } from "../shared/relay-frame.js";
import { loadIdentity } from "./identity.js";

type Frame = { id: string; event: "open" | "close" | "data"; data?: string };
type Channel = {
  socket: WebSocket | null;
  queue: string[];
  phonePublic: Uint8Array | null;
};

export function startTunnel(localPort: number) {
  const cloud = process.env.CLOUD_URL;
  if (!cloud) return;
  const identity = loadIdentity();
  const decoded = decodeKey(identity.secretKey);
  if (!decoded) throw new Error("本机身份文件损坏");
  const secretKey = decoded;
  const remoteUrl = cloud.replace(/^http/, "ws").replace(/\/$/, "") + `/link?serverId=${encodeURIComponent(identity.serverId)}`;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let remote: WebSocket | undefined;

  const connect = () => {
    if (stopped) return;
    const channels = new Map<string, Channel>();
    remote = new WebSocket(remoteUrl);
    keepAlive(remote);

    const closeChannels = () => {
      for (const channel of channels.values()) channel.socket?.close();
      channels.clear();
    };

    const sendData = (id: string, data: string) => {
      if (remote?.readyState === WebSocket.OPEN) remote.send(JSON.stringify({ id, event: "data", data }));
    };

    remote.on("open", () => console.log(`内网穿透已连上 ${cloud}`));
    remote.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Frame;
      if (frame.event === "open") {
        console.log("手机接入");
        channels.set(frame.id, { socket: null, queue: [], phonePublic: null });
        return;
      }
      const channel = channels.get(frame.id);
      if (!channel) return;
      if (frame.event === "close") {
        channel.socket?.close();
        channels.delete(frame.id);
        return;
      }
      if (frame.data === undefined) return;
      if (!channel.phonePublic) {
        const phonePublic = readHello(frame.data);
        if (!phonePublic) {
          console.log("手机握手无效");
          return;
        }
        channel.phonePublic = phonePublic;
        console.log("手机已配对");
        sendData(frame.id, JSON.stringify({ type: "e2ee_ready" }));
        openLocal(frame.id, channel);
        return;
      }
      const text = openBox(readBox(frame.data) || "", channel.phonePublic, secretKey);
      if (text === null) return;
      if (channel.socket?.readyState === WebSocket.OPEN) channel.socket.send(text);
      else channel.queue.push(text);
    });
    remote.on("close", () => {
      closeChannels();
      schedule();
    });
    remote.on("error", () => remote?.close());

    function openLocal(id: string, channel: Channel) {
      const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
      channel.socket = socket;
      socket.on("open", () => {
        for (const item of channel.queue) socket.send(item);
        channel.queue = [];
      });
      socket.on("message", (data) => {
        if (!channel.phonePublic) return;
        const boxed = JSON.stringify({ type: "box", data: seal(String(data), channel.phonePublic, secretKey) });
        sendData(id, boxed);
      });
      socket.on("close", () => {
        if (channels.get(id) === channel) channels.delete(id);
      });
    }
  };

  const schedule = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => {
      timer = undefined;
      connect();
    }, 2000);
  };

  connect();
}

function keepAlive(socket: WebSocket) {
  let alive = true;
  socket.on("pong", () => {
    alive = true;
  });
  const timer = setInterval(() => {
    if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) {
      clearInterval(timer);
      return;
    }
    if (socket.readyState !== WebSocket.OPEN) return;
    if (!alive) {
      clearInterval(timer);
      socket.terminate();
      return;
    }
    alive = false;
    socket.ping();
  }, 15000);
  socket.on("close", () => clearInterval(timer));
}

function readHello(data: string): Uint8Array | null {
  try {
    const parsed = JSON.parse(data) as { type?: string; key?: string };
    if (parsed.type !== "e2ee_hello" || !parsed.key) return null;
    return decodeKey(parsed.key);
  } catch {
    return null;
  }
}

function readBox(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { type?: string; data?: string };
    if (parsed.type !== "box" || !parsed.data) return null;
    return parsed.data;
  } catch {
    return null;
  }
}
