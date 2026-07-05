/**
 * SimpleFIN Bridge adapter (ADR-019).
 *
 * This is the only module that talks to SimpleFIN. Callers get structured
 * results instead of thrown fetch errors so the finance hub can degrade without
 * blocking page loads or scheduled runs.
 */

export interface SimplefinError {
  code?: string;
  msg?: string;
  conn_id?: string;
  account_id?: string;
}

export interface SimplefinConnection {
  conn_id: string;
  name: string;
  org_id?: string;
  org_name?: string;
  org_url?: string;
  sfin_url?: string;
}

export interface SimplefinTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  pending?: boolean;
}

export interface SimplefinHolding {
  id: string;
  created?: number;
  currency?: string;
  cost_basis?: string;
  description?: string;
  market_value: string;
  purchase_price?: string;
  shares: string;
  symbol?: string;
}

export interface SimplefinAccount {
  id: string;
  name: string;
  conn_id?: string;
  conn_name?: string;
  org?: { name?: string };
  currency: string;
  balance: string;
  "balance-date": number;
  transactions?: SimplefinTransaction[];
  holdings?: SimplefinHolding[];
}

export interface SimplefinPayload {
  errlist?: SimplefinError[];
  errors?: string[];
  connections?: SimplefinConnection[];
  accounts: SimplefinAccount[];
}

export interface SimplefinFetchResult {
  payload: SimplefinPayload | null;
  error?: string;
  status?: number;
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  if (typeof Buffer !== "undefined") return new Uint8Array(Buffer.from(base64, "base64"));
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function decodeBase64Text(base64: string): string {
  if (typeof Buffer !== "undefined") return Buffer.from(base64.trim(), "base64").toString("utf8");
  return new TextDecoder().decode(base64ToBytes(base64.trim()));
}

async function importAesKey(keyBase64: string): Promise<CryptoKey> {
  const raw = base64ToBytes(keyBase64);
  if (raw.byteLength !== 32) throw new Error("SIMPLEFIN_SEAL_KEY must be 32 bytes base64.");
  return crypto.subtle.importKey("raw", asArrayBuffer(raw), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function getSimplefinSealKey(): Promise<string | undefined> {
  return getServerEnvVar("SIMPLEFIN_SEAL_KEY");
}

export async function sealSecret(plaintext: string, keyBase64: string): Promise<string> {
  const key = await importAesKey(keyBase64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asArrayBuffer(iv) },
      key,
      asArrayBuffer(new TextEncoder().encode(plaintext)),
    ),
  );
  const out = new Uint8Array(iv.byteLength + ciphertext.byteLength);
  out.set(iv, 0);
  out.set(ciphertext, iv.byteLength);
  return bytesToBase64(out);
}

export async function openSecret(sealed: string, keyBase64: string): Promise<string> {
  const raw = base64ToBytes(sealed);
  if (raw.byteLength < 13) throw new Error("Sealed SimpleFIN secret is invalid.");
  const iv = raw.slice(0, 12);
  const ciphertext = raw.slice(12);
  const key = await importAesKey(keyBase64);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: asArrayBuffer(iv) },
    key,
    asArrayBuffer(ciphertext),
  );
  return new TextDecoder().decode(plaintext);
}

export function decodeSetupToken(token: string): string {
  const decoded = decodeBase64Text(token);
  const url = new URL(decoded);
  if (url.protocol !== "https:") throw new Error("SimpleFIN setup token must decode to HTTPS.");
  return url.toString();
}

export async function claimSetupToken(
  token: string,
): Promise<SimplefinFetchResult & { accessUrl?: string }> {
  let claimUrl: string;
  try {
    claimUrl = decodeSetupToken(token);
  } catch (err: any) {
    return { payload: null, error: err?.message || "Invalid setup token." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(claimUrl, {
      method: "POST",
      headers: { "Content-Length": "0" },
      signal: controller.signal,
    });
    const text = (await resp.text()).trim();
    if (!resp.ok) {
      return {
        payload: null,
        status: resp.status,
        error:
          resp.status === 403
            ? "SimpleFIN setup token was rejected or already claimed."
            : `SimpleFIN claim failed (${resp.status}).`,
      };
    }
    const access = new URL(text);
    if (access.protocol !== "https:") throw new Error("SimpleFIN access URL must be HTTPS.");
    return { payload: null, accessUrl: access.toString() };
  } catch (err: any) {
    return { payload: null, error: err?.message || "SimpleFIN claim failed." };
  } finally {
    clearTimeout(timer);
  }
}

function buildAccountsRequest(
  accessUrl: string,
  opts?: { startDate?: number; balancesOnly?: boolean },
): {
  url: string;
  auth: string;
} {
  const root = new URL(accessUrl);
  if (root.protocol !== "https:") throw new Error("SimpleFIN access URL must be HTTPS.");
  const username = decodeURIComponent(root.username);
  const password = decodeURIComponent(root.password);
  root.username = "";
  root.password = "";
  const base = root.toString().replace(/\/$/, "");
  const url = new URL(`${base}/accounts`);
  url.searchParams.set("version", "2");
  if (opts?.startDate) url.searchParams.set("start-date", String(Math.floor(opts.startDate)));
  if (opts?.balancesOnly) url.searchParams.set("balances-only", "1");
  return {
    url: url.toString(),
    auth: `Basic ${bytesToBase64(new TextEncoder().encode(`${username}:${password}`))}`,
  };
}

export async function fetchAccounts(
  accessUrl: string,
  opts?: { startDate?: number; balancesOnly?: boolean },
): Promise<SimplefinFetchResult> {
  let request: { url: string; auth: string };
  try {
    request = buildAccountsRequest(accessUrl, opts);
  } catch (err: any) {
    return { payload: null, error: err?.message || "Invalid SimpleFIN access URL." };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const resp = await fetch(request.url, {
      headers: { Authorization: request.auth },
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        payload: null,
        status: resp.status,
        error:
          resp.status === 403
            ? "SimpleFIN access was revoked or rejected."
            : `SimpleFIN accounts fetch failed (${resp.status}).`,
      };
    }
    const payload = (await resp.json()) as SimplefinPayload;
    return {
      payload: { ...payload, accounts: Array.isArray(payload.accounts) ? payload.accounts : [] },
    };
  } catch (err: any) {
    return { payload: null, error: err?.message || "SimpleFIN accounts fetch failed." };
  } finally {
    clearTimeout(timer);
  }
}
import { getServerEnvVar } from "@/server/env";
