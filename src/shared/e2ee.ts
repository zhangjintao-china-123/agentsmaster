import nacl from "tweetnacl";
import { bytesToBase64 } from "./relay-frame.js";

export type BoxKeys = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export function createBoxKeys(): BoxKeys {
  return nacl.box.keyPair();
}

export function seal(text: string, theirPublic: Uint8Array, mySecret: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const boxed = nacl.box(new TextEncoder().encode(text), nonce, theirPublic, mySecret);
  const packed = new Uint8Array(nonce.length + boxed.length);
  packed.set(nonce, 0);
  packed.set(boxed, nonce.length);
  return bytesToBase64(packed);
}

export function openBox(payload: string, theirPublic: Uint8Array, mySecret: Uint8Array): string | null {
  let packed: Uint8Array;
  try {
    packed = Uint8Array.from(atob(payload), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
  if (packed.length <= nacl.box.nonceLength) return null;
  const nonce = packed.slice(0, nacl.box.nonceLength);
  const boxed = packed.slice(nacl.box.nonceLength);
  const opened = nacl.box.open(boxed, nonce, theirPublic, mySecret);
  if (!opened) return null;
  return new TextDecoder().decode(opened);
}
