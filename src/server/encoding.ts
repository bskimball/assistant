/**
 * Base64/byte helpers shared by server modules (SimpleFIN sealing, exercise
 * art decoding). Buffer fast path on Node, atob/btoa fallback on Workers.
 */

export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"));
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

/** Copy into a standalone ArrayBuffer (WebCrypto APIs reject SharedArrayBuffer views). */
export function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export function decodeBase64Text(base64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(base64.trim(), "base64").toString("utf8");
  return new TextDecoder().decode(base64ToBytes(base64.trim()));
}
