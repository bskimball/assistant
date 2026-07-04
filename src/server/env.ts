import { env as cloudflareEnv } from "cloudflare:workers";

type CloudflareEnvRecord = Partial<CloudflareEnv> & Record<string, unknown>;

export function getCloudflareEnv(): CloudflareEnvRecord {
  return cloudflareEnv as CloudflareEnvRecord;
}

export async function getServerEnvVar(key: string): Promise<string | undefined> {
  const cfEnv = getCloudflareEnv();
  const fromCf = cfEnv[key];
  if (typeof fromCf === "string" && fromCf.length > 0) return fromCf;

  const fromGlobal = (globalThis as Record<string, unknown>)[key];
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) return fromGlobal;

  const fromProcess =
    typeof process !== "undefined" ? (process.env?.[key] as string | undefined) : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;

  return undefined;
}

export async function getCloudflareBinding<T>(key: string): Promise<T | undefined> {
  return getCloudflareEnv()[key] as T | undefined;
}
