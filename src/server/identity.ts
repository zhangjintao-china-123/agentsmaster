import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { createBoxKeys } from "../shared/e2ee.js";
import { bytesToBase64, decodeKey } from "../shared/relay-frame.js";

export type DaemonIdentity = {
  serverId: string;
  publicKey: string;
  secretKey: string;
};

const file = path.resolve("data/daemon-identity.json");
export const defaultPublicUrl = "https://agents.pptxgen.com";

export function ensurePublicUrl(): string {
  const configured = process.env.CLOUD_PUBLIC_URL?.trim();
  if (configured) return configured;
  process.env.CLOUD_PUBLIC_URL = defaultPublicUrl;
  return defaultPublicUrl;
}

export function loadIdentity(): DaemonIdentity {
  if (existsSync(file)) {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<DaemonIdentity>;
    if (!parsed.serverId || !parsed.publicKey || !parsed.secretKey) throw new Error("本机身份文件损坏");
    if (!decodeKey(parsed.publicKey) || !decodeKey(parsed.secretKey)) throw new Error("本机身份文件损坏");
    return { serverId: parsed.serverId, publicKey: parsed.publicKey, secretKey: parsed.secretKey };
  }
  const keys = createBoxKeys();
  const identity: DaemonIdentity = {
    serverId: randomUUID(),
    publicKey: bytesToBase64(keys.publicKey),
    secretKey: bytesToBase64(keys.secretKey),
  };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  chmodSync(file, 0o600);
  return identity;
}

export async function pairingCard(): Promise<{ url: string; svg: string } | null> {
  const cloud = ensurePublicUrl();
  const identity = loadIdentity();
  const base = cloud.replace(/^ws/, "http").replace(/\/$/, "");
  const url = `${base}/#server=${identity.serverId}&key=${encodeURIComponent(identity.publicKey)}`;
  const svg = (await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })).replace(/^<\?xml[^>]*>/, "");
  return { url, svg };
}
