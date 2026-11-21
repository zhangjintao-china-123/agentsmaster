import WebSocket from "ws";
import { openBox, seal } from "../shared/e2ee.js";
import { decodeKey } from "../shared/relay-frame.js";
import { acceptPairCode, currentPairCode, currentSecretKey, ensureCloudUrl, loadIdentity } from "./identity.js";

type Frame = { id: string; event: "open" | "close" | "data"; data?: string };
type Channel = {
  socket: WebSocket | null;
  queue: string[];
  phonePublic: Uint8Array | null;
  generation: string;
  openTimer?: ReturnType<typeof setTimeout>;
};

function safeClose(socket: WebSocket | null | undefined) {
  if (!socket) return;
  if (socket.readyState === WebSocket.CONNECTING) {
    socket.once("open", () => socket.close());
    socket.terminate();
    return;
  }
  if (socket.readyState === WebSocket.OPEN) socket.close();
}

function dropChannel(channels: Map<string, Channel>, id: string, channel: Channel) {
  if (channel.openTimer) clearTimeout(channel.openTimer);
  channel.openTimer = undefined;
  safeClose(channel.socket);
  channel.socket = null;
  if (channels.get(id) === channel) channels.delete(id);
}

export function startTunnel(localPort: number) {
  const cloud = ensureCloudUrl();
  const identity = loadIdentity();
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
      for (const [id, channel] of channels) dropChannel(channels, id, channel);
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
        channels.set(frame.id, { socket: null, queue: [], phonePublic: null, generation: "" });
        return;
      }
      const channel = channels.get(frame.id);
      if (!channel) return;
      if (frame.event === "close") {
        dropChannel(channels, frame.id, channel);
        return;
      }
      if (frame.data === undefined) return;
      if (!channel.phonePublic) {
        const hello = readHello(frame.data);
        if (!hello) {
          console.log("手机握手无效");
          return;
        }
        if (!acceptPairCode(hello.code)) {
          sendData(frame.id, JSON.stringify({ type: "e2ee_rejected", message: "授权码已失效，请重新扫一扫" }));
          return;
        }
        channel.phonePublic = hello.publicKey;
        channel.generation = currentPairCode();
        console.log("手机已配对");
        sendData(frame.id, JSON.stringify({ type: "e2ee_ready" }));
        channel.openTimer = setTimeout(() => openLocal(frame.id, channel), 80);
        return;
      }
      if (channel.generation !== currentPairCode()) {
        sendData(frame.id, JSON.stringify({ type: "e2ee_rejected", message: "授权码已失效，请重新扫一扫" }));
        dropChannel(channels, frame.id, channel);
        return;
      }
      const text = openBox(readBox(frame.data) || "", channel.phonePublic, currentSecretKey());
      if (text === null) return;
      if (channel.socket?.readyState === WebSocket.OPEN) channel.socket.send(text);
      else channel.queue.push(text);
    });
    remote.on("close", () => {
      closeChannels();
      schedule();
    });
    remote.on("error", () => safeClose(remote));

    function openLocal(id: string, channel: Channel) {
      channel.openTimer = undefined;
      if (channels.get(id) !== channel) return;
      const socket = new WebSocket(`ws://127.0.0.1:${localPort}/ws`);
      channel.socket = socket;
      socket.on("error", () => undefined);
      socket.on("open", () => {
        if (channels.get(id) !== channel) {
          safeClose(socket);
          return;
        }
        for (const item of channel.queue) socket.send(item);
        channel.queue = [];
      });
      socket.on("message", (data) => {
        if (!channel.phonePublic) return;
        const boxed = JSON.stringify({ type: "box", data: seal(String(data), channel.phonePublic, currentSecretKey()) });
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

function readHello(data: string): { publicKey: Uint8Array; code?: string } | null {
  try {
    const parsed = JSON.parse(data) as { type?: string; key?: string; code?: string };
    if (parsed.type !== "e2ee_hello" || !parsed.key) return null;
    const publicKey = decodeKey(parsed.key);
    if (!publicKey) return null;
    return { publicKey, code: parsed.code || undefined };
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
