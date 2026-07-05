type CloudflareEnvRecord = Partial<CloudflareEnv> & Record<string, unknown>;
type CloudflareWorkersModule = { env?: CloudflareEnvRecord };

const cloudflareWorkersModuleName = "cloudflare:workers";

let cloudflareEnvPromise: Promise<CloudflareEnvRecord> | null = null;

export async function getCloudflareEnv(): Promise<CloudflareEnvRecord> {
  if (typeof window !== "undefined") {
    return {};
  }

  cloudflareEnvPromise ??= import(cloudflareWorkersModuleName)
    .then((mod) => ((mod as CloudflareWorkersModule).env ?? {}) as CloudflareEnvRecord)
    .catch(() => ({}));

  return cloudflareEnvPromise;
}

export async function getServerEnvVar(key: string): Promise<string | undefined> {
  const cfEnv = await getCloudflareEnv();
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
  return (await getCloudflareEnv())[key] as T | undefined;
}
