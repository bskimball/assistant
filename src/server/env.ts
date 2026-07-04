let localDevVars: Map<string, string> | null | undefined;
let localPlatformEnv: Record<string, unknown> | null | undefined;

export async function getCloudflareEnv(): Promise<Record<string, unknown> | undefined> {
  try {
    const importCloudflareWorkers = new Function(
      "return import('cloudflare:workers')",
    ) as () => Promise<{ env?: Record<string, unknown> }>;
    return (await importCloudflareWorkers()).env;
  } catch {
    return undefined;
  }
}

async function loadLocalDevVars(): Promise<Map<string, string> | undefined> {
  if (localDevVars !== undefined) return localDevVars ?? undefined;
  localDevVars = null;
  if (typeof process === "undefined" || process.env?.NODE_ENV === "production") {
    return undefined;
  }

  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = await fs.readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
    localDevVars = new Map();
    for (const line of file.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (!match) continue;
      localDevVars.set(match[1].trim(), match[2].trim().replace(/^(['"])(.*)\1$/, "$2"));
    }
  } catch {
    localDevVars = null;
  }

  return localDevVars ?? undefined;
}

export async function getServerEnvVar(key: string): Promise<string | undefined> {
  const cfEnv = await getCloudflareEnv();
  const fromCf = cfEnv?.[key];
  if (typeof fromCf === "string" && fromCf.length > 0) return fromCf;

  const fromGlobal = (globalThis as Record<string, unknown>)[key];
  if (typeof fromGlobal === "string" && fromGlobal.length > 0) return fromGlobal;

  const fromProcess =
    typeof process !== "undefined" ? (process.env?.[key] as string | undefined) : undefined;
  if (typeof fromProcess === "string" && fromProcess.length > 0) return fromProcess;

  return (await loadLocalDevVars())?.get(key);
}

export async function getCloudflareBinding<T>(key: string): Promise<T | undefined> {
  const cfEnv = await getCloudflareEnv();
  const fromCf = cfEnv?.[key];
  if (fromCf) return fromCf as T;
  const localEnv = await getLocalPlatformEnv();
  return localEnv?.[key] as T | undefined;
}

async function getLocalPlatformEnv(): Promise<Record<string, unknown> | undefined> {
  if (localPlatformEnv !== undefined) return localPlatformEnv ?? undefined;
  localPlatformEnv = null;
  if (typeof process === "undefined" || process.env?.NODE_ENV === "production") {
    return undefined;
  }

  try {
    const wrangler = (await import("wrangler")) as {
      getPlatformProxy?: (options?: {
        configPath?: string;
        persist?: boolean;
        remoteBindings?: boolean;
      }) => Promise<{ env?: Record<string, unknown> }>;
    };
    const proxy = await wrangler.getPlatformProxy?.({
      configPath: "wrangler.jsonc",
      persist: true,
      remoteBindings: false,
    });
    localPlatformEnv = proxy?.env ?? null;
  } catch {
    localPlatformEnv = null;
  }

  return localPlatformEnv ?? undefined;
}
