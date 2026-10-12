import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import QRCode from "qrcode";
import { createBoxKeys } from "../shared/e2ee.js";
import { bytesToBase64, decodeKey } from "../shared/relay-frame.js";

export type DaemonIdentity = {
  serverId: string;
  publicKey: string;
  secretKey: string;
};

export const pairPolicies = ["forever", "1h", "24h", "7d"] as const;
export type PairPolicy = (typeof pairPolicies)[number];

export type PairingCard = {
  url: string;
  svg: string;
  policy: PairPolicy;
  expiresAt: number | null;
  detail: string;
};

type StoredIdentity = DaemonIdentity & {
  pairPolicy: PairPolicy;
  pairCode: string;
  pairExpiresAt: number | null;
  pairLegacy: boolean;
};

const file = process.env.AGENTSMASTER_IDENTITY_FILE || path.resolve("data/daemon-identity.json");
export const defaultPublicUrl = "https://agents.pptxgen.com";

export function ensurePublicUrl(): string {
  const configured = process.env.CLOUD_PUBLIC_URL?.trim();
  if (configured) return configured;
  process.env.CLOUD_PUBLIC_URL = defaultPublicUrl;
  return defaultPublicUrl;
}
const pairDuration: Record<PairPolicy, number | null> = {
  forever: null,
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
};

let cached: StoredIdentity | null = null;

export function loadIdentity(): DaemonIdentity {
  const stored = ensureFresh();
  return { serverId: stored.serverId, publicKey: stored.publicKey, secretKey: stored.secretKey };
}

export function currentSecretKey(): Uint8Array {
  const decoded = decodeKey(ensureFresh().secretKey);
  if (!decoded) throw new Error("本机身份文件损坏");
  return decoded;
}

export function currentPairCode(): string {
  return ensureFresh().pairCode;
}

export function acceptPairCode(code: string | undefined): boolean {
  const stored = ensureFresh();
  if (code && code === stored.pairCode) return true;
  return stored.pairLegacy && !code;
}

export async function pairingCard(): Promise<PairingCard | null> {
  return renderCard(ensureFresh(), ensurePublicUrl());
}

export async function setPairing(input: { policy?: string; rotate?: boolean }): Promise<PairingCard> {
  const cloud = ensurePublicUrl();
  const stored = ensureFresh();
  const policy = input.policy == null || input.policy === "" ? stored.pairPolicy : parsePolicy(input.policy);
  if (input.rotate || policy !== stored.pairPolicy) rotate(policy);
  return renderCard(ensureFresh(), cloud);
}

function parsePolicy(value: string): PairPolicy {
  if ((pairPolicies as readonly string[]).includes(value)) return value as PairPolicy;
  throw new Error("不支持的授权码期限");
}

function ensureFresh(): StoredIdentity {
  const stored = readStored();
  if (stored.pairExpiresAt != null && Date.now() >= stored.pairExpiresAt) return rotate(stored.pairPolicy);
  return stored;
}

function readStored(): StoredIdentity {
  if (cached) return cached;
  if (!existsSync(file)) {
    cached = createStored("forever", false);
    persist(cached);
    return cached;
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredIdentity>;
  if (!parsed.serverId || !parsed.publicKey || !parsed.secretKey) throw new Error("本机身份文件损坏");
  if (!decodeKey(parsed.publicKey) || !decodeKey(parsed.secretKey)) throw new Error("本机身份文件损坏");
  const policy = parsed.pairPolicy && (pairPolicies as readonly string[]).includes(parsed.pairPolicy) ? parsed.pairPolicy : "forever";
  cached = {
    serverId: parsed.serverId,
    publicKey: parsed.publicKey,
    secretKey: parsed.secretKey,
    pairPolicy: policy,
    pairCode: parsed.pairCode || newCode(),
    pairExpiresAt: policy === "forever" ? null : parsed.pairExpiresAt ?? Date.now() + (pairDuration[policy] || 0),
    pairLegacy: parsed.pairCode ? parsed.pairLegacy === true : true,
  };
  if (!parsed.pairCode || parsed.pairPolicy !== cached.pairPolicy || parsed.pairLegacy !== cached.pairLegacy) persist(cached);
  return cached;
}

function createStored(policy: PairPolicy, legacy: boolean): StoredIdentity {
  const keys = createBoxKeys();
  return {
    serverId: randomUUID(),
    publicKey: bytesToBase64(keys.publicKey),
    secretKey: bytesToBase64(keys.secretKey),
    pairPolicy: policy,
    pairCode: newCode(),
    pairExpiresAt: expiry(policy),
    pairLegacy: legacy,
  };
}

function rotate(policy: PairPolicy): StoredIdentity {
  const current = readStored();
  const keys = createBoxKeys();
  cached = {
    serverId: current.serverId,
    publicKey: bytesToBase64(keys.publicKey),
    secretKey: bytesToBase64(keys.secretKey),
    pairPolicy: policy,
    pairCode: newCode(),
    pairExpiresAt: expiry(policy),
    pairLegacy: false,
  };
  persist(cached);
  return cached;
}

function expiry(policy: PairPolicy): number | null {
  const duration = pairDuration[policy];
  return duration == null ? null : Date.now() + duration;
}

function newCode(): string {
  return randomBytes(18).toString("base64url");
}

function persist(identity: StoredIdentity) {
  mkdirSync(path.dirname(file), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  writeFileSync(file, JSON.stringify(identity), { mode: 0o600 });
  chmodSync(file, mode);
}

async function renderCard(stored: StoredIdentity, cloud: string): Promise<PairingCard> {
  const base = cloud.replace(/^ws/, "http").replace(/\/$/, "");
  const url = `${base}/#server=${stored.serverId}&key=${encodeURIComponent(stored.publicKey)}&code=${encodeURIComponent(stored.pairCode)}`;
  const svg = (await QRCode.toString(url, { type: "svg", margin: 1, errorCorrectionLevel: "M" })).replace(/^<\?xml[^>]*>/, "");
  return { url, svg, policy: stored.pairPolicy, expiresAt: stored.pairExpiresAt, detail: pairDetail(stored) };
}

function pairDetail(stored: StoredIdentity): string {
  if (stored.pairExpiresAt == null) return "这个授权码永久有效。已经扫过的手机可以一直用。点「立即更换」后，旧码失效，手机要重新扫。";
  const when = new Date(stored.pairExpiresAt).toLocaleString("zh-CN", { hour12: false });
  return `这个授权码在 ${when} 前有效。到期后自动更换，旧码失效，手机要重新扫。`;
}
