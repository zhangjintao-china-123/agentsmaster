import { createBoxKeys, openBox, seal, type BoxKeys } from "../shared/e2ee";
import { bytesToBase64, decodeKey } from "../shared/relay-frame";

export type Pair = { serverId: string; publicKey: string };

const storageKey = "agentsmaster-pair";

export function isDirectHost() {
  return location.hostname === "localhost" || location.hostname === "127.0.0.1" || location.port === "5174";
}

export function savePair(pair: Pair) {
  if (!decodeKey(pair.publicKey)) return;
  localStorage.setItem(storageKey, JSON.stringify(pair));
}

export function pairFromScan(text: string): Pair | null {
  const hashAt = text.indexOf("#");
  const params = new URLSearchParams(hashAt >= 0 ? text.slice(hashAt + 1) : text);
  const serverId = params.get("server");
  const publicKey = params.get("key");
  if (!serverId || !publicKey || !decodeKey(publicKey)) return null;
  return { serverId, publicKey };
}

export function loadPair(): Pair | null {
  const params = new URLSearchParams(location.hash.replace(/^#/, ""));
  const serverId = params.get("server");
  const publicKey = params.get("key");
  if (serverId && publicKey && decodeKey(publicKey)) {
    const pair = { serverId, publicKey };
    localStorage.setItem(storageKey, JSON.stringify(pair));
    history.replaceState(null, "", location.pathname);
    return pair;
  }
  const saved = localStorage.getItem(storageKey);
  if (!saved) return null;
  try {
    const pair = JSON.parse(saved) as Pair;
    if (!pair.serverId || !decodeKey(pair.publicKey)) return null;
    return pair;
  } catch {
    return null;
  }
}

export function connectLink(options: {
  pair: Pair | null;
  onOpen: () => void;
  onClose: () => void;
  onMessage: (message: unknown) => void;
}): { send: (payload: unknown) => void; close: () => void } {
  let socket: WebSocket | null = null;
  let stopped = false;
  let timer = 0;
  let ready = false;
  let mine: BoxKeys | null = null;
  const theirs = options.pair ? decodeKey(options.pair.publicKey) : null;

  const send = (payload: unknown) => {
    if (!ready || !socket) return;
    if (!options.pair || !mine || !theirs) {
      socket.send(JSON.stringify(payload));
      return;
    }
    socket.send(JSON.stringify({ type: "box", data: seal(JSON.stringify(payload), theirs, mine.secretKey) }));
  };

  const open = () => {
    if (stopped) return;
    ready = false;
    mine = options.pair ? createBoxKeys() : null;
    const protocol = location.protocol === "https:" ? "wss" : "ws";
    const query = options.pair ? `?serverId=${encodeURIComponent(options.pair.serverId)}` : "";
    socket = new WebSocket(`${protocol}://${location.host}/ws${query}`);
    socket.onopen = () => {
      if (!options.pair || !mine) {
        ready = true;
        options.onOpen();
        return;
      }
      socket?.send(JSON.stringify({ type: "e2ee_hello", key: bytesToBase64(mine.publicKey) }));
    };
    socket.onclose = () => {
      ready = false;
      options.onClose();
      if (!stopped) timer = window.setTimeout(open, 1200);
    };
    socket.onmessage = (event) => {
      if (!options.pair || !mine || !theirs) {
        options.onMessage(JSON.parse(String(event.data)));
        return;
      }
      const parsed = JSON.parse(String(event.data)) as { type?: string; message?: string; data?: string };
      if (parsed.type === "error") {
        options.onMessage(parsed);
        socket?.close();
        return;
      }
      if (parsed.type === "e2ee_ready") {
        ready = true;
        options.onOpen();
        return;
      }
      if (parsed.type !== "box" || !parsed.data) return;
      const text = openBox(parsed.data, theirs, mine.secretKey);
      if (text) options.onMessage(JSON.parse(text));
    };
  };

  open();
  return {
    send,
    close: () => {
      stopped = true;
      window.clearTimeout(timer);
      socket?.close();
    },
  };
}
