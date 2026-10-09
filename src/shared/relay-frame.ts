export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function decodeKey(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]{43}=$/.test(value)) return null;
  let bytes: Uint8Array;
  try {
    bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (bytes.length !== 32 || bytesToBase64(bytes) !== value) return null;
  return bytes;
}

export function acceptRelayPayload(text: string): boolean {
  let parsed: { type?: unknown; key?: unknown; data?: unknown };
  try {
    parsed = JSON.parse(text) as { type?: unknown; key?: unknown; data?: unknown };
  } catch {
    return false;
  }
  if (parsed.type === "e2ee_hello") return typeof parsed.key === "string" && decodeKey(parsed.key) !== null;
  if (parsed.type === "box") return typeof parsed.data === "string" && parsed.data.length > 0 && parsed.data.length < 8_000_000;
  return false;
}
