import { createBoxKeys, openBox, seal, type BoxKeys } from "../../src/shared/e2ee";
import { decodeKey } from "../../src/shared/relay-frame";

export type Pair = { serverId: string; publicKey: string };

const storageKey = "agentsmaster-pair";
const relayHost = "agents.pptxgen.com";

export function isDirectHost() {
  if (typeof location === "undefined") return false;
  return location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.port === "5174";
}

export function pairFromScan(text: string): Pair | null {
  const hashAt = text.indexOf("#");
  const params = new URLSearchParams(hashAt >= 0 ? text.slice(hashAt + 1) : text);
  const serverId = params.get("server");
  const publicKey = params.get("key");
  if (!serverId || !publicKey || !decodeKey(publicKey)) return null;
  return { serverId, publicKey };
}

export function savePair(pair: Pair) {
  if (!decodeKey(pair.publicKey)) return;
  uni.setStorageSync(storageKey, JSON.stringify(pair));
}

export function loadPair(): Pair | null {
  if (typeof location !== "undefined") {
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const serverId = params.get("server");
    const publicKey = params.get("key");
    if (serverId && publicKey && decodeKey(publicKey)) {
      const pair = { serverId, publicKey };
      savePair(pair);
      history.replaceState(null, "", location.pathname + location.search);
      return pair;
    }
  }
  const saved = uni.getStorageSync(storageKey);
  if (!saved || typeof saved !== "string") return null;
  try {
    const pair = JSON.parse(saved) as Pair;
    if (!pair.serverId || !decodeKey(pair.publicKey)) return null;
    return pair;
  } catch {
    return null;
  }
}

function socketUrl(pair: Pair | null) {
  const protocol = typeof location !== "undefined" && location.protocol === "https:" ? "wss" : "ws";
  const host = typeof location !== "undefined" ? location.hostname : "";
  if (pair) {
    const pageHost = typeof location !== "undefined" && location.host ? location.host : relayHost;
    return `${protocol}://${pageHost}/ws?serverId=${encodeURIComponent(pair.serverId)}`;
  }
  if (host) return `ws://${host}:8787/ws`;
  return `${protocol}://${location.host}/ws`;
}

type SocketHandle = { send: (data: string) => void; close: () => void };

function openSocket(url: string, onMessage: (data: string) => void, onOpen: () => void, onClose: () => void): SocketHandle {
  const socket = new WebSocket(url);
  socket.onopen = () => onOpen();
  socket.onclose = () => onClose();
  socket.onerror = () => socket.close();
  socket.onmessage = (event) => onMessage(String(event.data));
  return {
    send: (data) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(data);
    },
    close: () => socket.close(),
  };
}

export function connectLink(options: {
  pair: Pair | null;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (message: unknown) => void;
}) {
  let stopped = false;
  let ready = false;
  let timer = 0;
  let handle: SocketHandle | null = null;
  let mine: BoxKeys | null = null;
  const theirs = options.pair ? decodeKey(options.pair.publicKey) : null;

  const throughCloud = (() => {
    const host = typeof location !== "undefined" ? location.hostname : "";
    return host === relayHost || (!!options.pair && (host === "localhost" || host === "127.0.0.1"));
  })();

  const send = (payload: unknown) => {
    const kind = payload && typeof payload === "object" && "type" in payload ? (payload as { type?: string }).type : "";
    if (kind === "asr") {
      if (!throughCloud) {
        options.onMessage({ type: "asr_error", message: "语音识别只在云端进行" });
        return;
      }
      handle?.send(JSON.stringify(payload));
      return;
    }
    if (!ready || !handle) return;
    if (!options.pair || !mine || !theirs) {
      handle.send(JSON.stringify(payload));
      return;
    }
    handle.send(JSON.stringify({ type: "box", data: seal(JSON.stringify(payload), theirs, mine.secretKey) }));
  };

  const open = () => {
    if (stopped) return;
    ready = false;
    mine = options.pair ? createBoxKeys() : null;
    handle = openSocket(socketUrl(options.pair), (data) => {
      let parsed: { type?: string; data?: string };
      try {
        parsed = JSON.parse(data) as { type?: string; data?: string };
      } catch {
        return;
      }
      if (parsed.type === "asr_text" || parsed.type === "asr_error") {
        options.onMessage(parsed);
        return;
      }
      if (!options.pair) {
        options.onMessage(parsed);
        return;
      }
      if (parsed.type === "e2ee_ready") {
        ready = true;
        options.onOpen();
        return;
      }
      if (parsed.type !== "box" || !parsed.data || !mine || !theirs) return;
      const text = openBox(parsed.data, theirs, mine.secretKey);
      if (!text) return;
      options.onMessage(JSON.parse(text));
    }, () => {
      if (!options.pair || !mine) {
        ready = true;
        options.onOpen();
        return;
      }
      handle?.send(JSON.stringify({ type: "e2ee_hello", key: bytesToBase64(mine.publicKey) }));
    }, () => {
      ready = false;
      options.onClose();
      if (!stopped) timer = setTimeout(open, 1200) as unknown as number;
    });
  };

  open();
  return {
    send,
    close: () => {
      stopped = true;
      clearTimeout(timer);
      handle?.close();
    },
  };
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
