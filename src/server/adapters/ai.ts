export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface JSONChatRequest {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

async function getCloudflareEnv(): Promise<Record<string, unknown> | undefined> {
  try {
    const importCloudflareWorkers = new Function(
      "return import('cloudflare:workers')",
    ) as () => Promise<{ env?: Record<string, unknown> }>;
    return (await importCloudflareWorkers()).env;
  } catch {
    return undefined;
  }
}

async function getLocalDevVar(key: string): Promise<string | undefined> {
  if (typeof process === "undefined" || process.env?.NODE_ENV === "production") return undefined;
  try {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const file = await fs.readFile(path.join(process.cwd(), ".dev.vars"), "utf8");
    for (const line of file.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const match = trimmed.match(/^([^=]+)=(.*)$/);
      if (!match || match[1].trim() !== key) continue;
      return match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function getGrokApiKey(): Promise<string | undefined> {
  const cfEnv = await getCloudflareEnv();
  const apiKey = cfEnv?.GROK_API_KEY;
  if (typeof apiKey === "string" && apiKey.length > 0) return apiKey;
  const globalKey = (globalThis as any).GROK_API_KEY || process?.env?.GROK_API_KEY;
  if (typeof globalKey === "string" && globalKey.length > 0) return globalKey;
  return getLocalDevVar("GROK_API_KEY");
}

export function stripJsonFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```json\s*|\s*```$/g, "")
    .trim();
}

export async function completeJSON<T>(apiKey: string, request: JSONChatRequest): Promise<T> {
  const resp = await fetch("https://api.x.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: request.model ?? "grok-3-mini",
      messages: request.messages,
      temperature: request.temperature ?? 0.1,
      max_tokens: request.maxTokens ?? 400,
    }),
  });
  if (!resp.ok) throw new Error("Grok HTTP " + resp.status);
  const data: any = await resp.json();
  const raw = (data.choices?.[0]?.message?.content || "{}").trim();
  return JSON.parse(stripJsonFence(raw)) as T;
}
