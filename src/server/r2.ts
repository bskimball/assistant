/**
 * R2 data access layer for the assistant.
 *
 * Per ADR-001:
 * - All persistent user data lives in Cloudflare R2 under user-scoped prefixes.
 * - Key convention: assistant/{userId}/{collection}.json (and domain sharded variants)
 *
 * Per consolidated ADR-003:
 * - Daily aggregates: assistant/brian/{domain}/{YYYY-MM-DD}.json (read-modify-write)
 * - Append-only logs (AI/voice): assistant/brian/{domain}/{date}.jsonl (or single file)
 * - Weekly: .../{domain}/{YYYY}-Www.json
 * - Soft-delete index (for efficient hard-delete): assistant/brian/meta/deleted/{YYYY-MM-DD}.json
 * - Helpers below are the source of truth for key construction.
 *
 * TanStack DB is used only for in-memory reactive client state.
 * Server reads/writes always go through R2 via Workers (this module).
 *
 * Local dev: requires the @cloudflare/vite-plugin (injected via vite.config)
 * or `wrangler dev`. The binding "R2" must be present.
 */

import type { AIInteraction, VoiceTranscript } from "@/lib/domain";

async function getCloudflareEnv() {
  const { env } = await import("cloudflare:workers");
  return env;
}

// Fixed user for personal deployment (Brian). Future: derive from session / Access.
export const USER_ID = "brian";

export function getUserPrefix(userId: string = USER_ID): string {
  return `assistant/${userId}`;
}

export function getKey(collection: string, userId: string = USER_ID): string {
  return `${getUserPrefix(userId)}/${collection}`;
}

/**
 * Get the R2 bucket binding.
 * Throws with actionable message if unavailable (common during misconfigured dev).
 */
export async function getR2Bucket(): Promise<R2Bucket> {
  const env = await getCloudflareEnv();
  const bucket = env.R2 as R2Bucket | undefined;
  if (!bucket) {
    throw new Error(
      'R2 bucket binding "R2" is not available. ' +
        "Run with `npm run dev` (uses CF plugin) or `npm run dev:cf`. " +
        "Ensure wrangler.jsonc defines an r2_buckets binding and you have created the bucket: " +
        "npx wrangler r2 bucket create assistant-data",
    );
  }
  return bucket;
}

/**
 * Read an object as text (or null if missing).
 */
export async function getObjectText(key: string): Promise<string | null> {
  const bucket = await getR2Bucket();
  const obj = await bucket.get(key);
  if (!obj) return null;
  return await obj.text();
}

/**
 * Read and JSON-parse. Returns null if missing or invalid.
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const text = await getObjectText(key);
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Write string data to key. Use putJSON for objects.
 */
export async function putObject(
  key: string,
  data: string | ArrayBuffer | ReadableStream,
  options?: R2PutOptions,
): Promise<void> {
  const bucket = await getR2Bucket();
  await bucket.put(key, data, options);
}

/**
 * Write a JSON-serializable value.
 */
export async function putJSON<T>(key: string, value: T): Promise<void> {
  const json = JSON.stringify(value, null, 0);
  await putObject(key, json, {
    httpMetadata: { contentType: "application/json" },
  });
}

/**
 * Delete an object.
 */
export async function deleteObject(key: string): Promise<void> {
  const bucket = await getR2Bucket();
  await bucket.delete(key);
}

/**
 * List keys under a prefix (useful for future collections that use sharded keys).
 */
export async function listKeys(prefix: string): Promise<string[]> {
  const bucket = await getR2Bucket();
  const listed = await bucket.list({ prefix });
  return listed.objects.map((o) => o.key);
}

/* =====================================================
   ADR-002 / ADR-003 + Glossary: Domain-aware key helpers
   ===================================================== */

/**
 * Daily aggregate key pattern:
 *   assistant/brian/{domain}/{YYYY-MM-DD}.json
 *
 * Examples:
 *   assistant/brian/daily-nutrition/2026-06-22.json
 *   assistant/brian/daily-plan/2026-06-22.json
 *   assistant/brian/productivity-tasks/2026-06-22.json
 */
export function getDailyKey(date: string, domain: string, userId = USER_ID): string {
  return `${getUserPrefix(userId)}/${domain}/${date}.json`;
}

/**
 * Weekly aggregate key pattern:
 *   assistant/brian/{domain}/{YYYY}-W{ww}.json
 *
 * Example: assistant/brian/weekly-review/2026-W25.json
 */
export function getWeeklyKey(week: string, domain: string, userId = USER_ID): string {
  return `${getUserPrefix(userId)}/${domain}/${week}.json`;
}

/**
 * Append-only log pattern (AI interactions, voice transcripts).
 * For v1 we support either:
 *   - Per-day: assistant/brian/{domain}/{YYYY-MM-DD}.jsonl
 *   - Or a single growing file: assistant/brian/{domain}.jsonl
 *
 * Use appendLogLine() helper when writing.
 */
export function getLogKey(domain: string, date?: string, userId = USER_ID): string {
  if (date) {
    return `${getUserPrefix(userId)}/${domain}/${date}.jsonl`;
  }
  return `${getUserPrefix(userId)}/${domain}.jsonl`;
}

/**
 * Long-lived reference data (rarely updated):
 *   assistant/brian/{collection}.json
 * Examples: exercise-library.json, user-preferences.json
 */
export function getRefKey(collection: string, userId = USER_ID): string {
  return getKey(collection, userId);
}

/**
 * Convenience: domain-specific collection for flat or sharded data.
 * Prefer getDailyKey / getRefKey for the patterns above.
 */
export function getDomainKey(domain: string, suffix = ".json", userId = USER_ID): string {
  return `${getUserPrefix(userId)}/${domain}${suffix.startsWith(".") ? suffix : `.${suffix}`}`;
}

/**
 * Append a line to an append-only .jsonl log.
 * Reads existing content (if any), appends a single JSON line, writes back.
 * Acceptable for personal scale; for high volume we can shard by date.
 */
export async function appendLogLine(key: string, record: unknown): Promise<void> {
  const existing = (await getObjectText(key)) || "";
  const line = JSON.stringify(record);
  const next = existing ? `${existing.trim()}\n${line}` : line;
  await putObject(key, next, {
    httpMetadata: { contentType: "application/jsonl" },
  });
}

/* =====================================================
   ADR-004: Voice / AI individual object keys (per-object append-only)
   assistant/brian/ai/transcripts/{id}.json
   assistant/brian/ai/interactions/{id}.json
   These give each record its own identity (vs daily jsonl) so audio can be
   attached later and individual soft-delete is natural.
   ===================================================== */

export function getVoiceTranscriptKey(id: string, userId = USER_ID): string {
  return `${getUserPrefix(userId)}/ai/transcripts/${id}.json`;
}

export function getAIInteractionKey(id: string, userId = USER_ID): string {
  return `${getUserPrefix(userId)}/ai/interactions/${id}.json`;
}

export async function putVoiceTranscript(record: VoiceTranscript): Promise<void> {
  const key = getVoiceTranscriptKey(record.id);
  await putJSON(key, record);
}

export async function putAIInteraction(record: AIInteraction): Promise<void> {
  const key = getAIInteractionKey(record.id);
  await putJSON(key, record);
}

/** List keys under the AI transcripts or interactions prefix (for recent context). */
export async function listAIKeys(
  subdir: "transcripts" | "interactions",
  userId = USER_ID,
): Promise<string[]> {
  const prefix = `${getUserPrefix(userId)}/ai/${subdir}/`;
  return listKeys(prefix);
}

/* =====================================================
   ADR-003 (consolidated): Soft-delete index + hard-delete support
   ===================================================== */

export type Timestamp = number;

/**
 * Record written to date-sharded soft-delete indexes.
 * Used by the 7-day hard-delete worker to avoid full-bucket scans.
 */
export interface SoftDeleteRecord {
  /** Full R2 key of the object to delete */
  key: string;
  /** When the soft-delete was recorded (ms epoch) */
  deletedAt: Timestamp;
  /** Optional domain hint for the object (e.g. 'daily-nutrition') */
  domain?: string;
}

/**
 * Sharded soft-delete index key:
 *   assistant/brian/meta/deleted/{YYYY-MM-DD}.json
 *
 * Each shard contains a small JSON array of SoftDeleteRecord.
 * Worker only needs to look at the most recent ~8 shards.
 */
export function getDeletedIndexKey(date: string, userId = USER_ID): string {
  return `${getUserPrefix(userId)}/meta/deleted/${date}.json`;
}

/**
 * Read a day's soft-delete index shard (returns [] if missing or invalid).
 */
export async function getDeletedIndex(date: string, userId = USER_ID): Promise<SoftDeleteRecord[]> {
  const key = getDeletedIndexKey(date, userId);
  const arr = await getJSON<SoftDeleteRecord[]>(key);
  return Array.isArray(arr) ? arr : [];
}

/**
 * Record a soft-delete for the given object key.
 * Appends (or creates) an entry in today's delete index shard.
 * Idempotent enough for personal use (duplicates are harmless to the worker).
 */
export async function recordSoftDelete(
  deletedKey: string,
  deletedAt: Timestamp,
  domain?: string,
  userId = USER_ID,
): Promise<void> {
  const date = new Date(deletedAt).toISOString().slice(0, 10);
  const idxKey = getDeletedIndexKey(date, userId);
  const existing = await getDeletedIndex(date, userId);
  const record: SoftDeleteRecord = { key: deletedKey, deletedAt, domain };
  // Avoid exact dups for the same key+deletedAt
  const deduped = existing.filter(
    (r) => !(r.key === record.key && r.deletedAt === record.deletedAt),
  );
  deduped.push(record);
  await putJSON(idxKey, deduped);
}

/**
 * Convenience: delete the index shard itself (used by hard-delete worker after processing).
 */
export async function deleteDeletedIndexShard(date: string, userId = USER_ID): Promise<void> {
  const key = getDeletedIndexKey(date, userId);
  await deleteObject(key);
}
