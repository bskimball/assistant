/**
 * R2 data access layer for the assistant.
 *
 * Per ADR-001:
 * - All persistent user data lives in Cloudflare R2 under user-scoped prefixes.
 * - Key convention: assistant/{userId}/{collection}.json
 * - TanStack DB is used only for in-memory reactive client state.
 * - Server reads/writes always go through R2 via Workers (this module).
 *
 * Local dev: requires the @cloudflare/vite-plugin (injected via vite.config)
 * or `wrangler dev`. The binding "R2" must be present.
 */

import { env } from 'cloudflare:workers'

// Fixed user for personal deployment (Brian). Future: derive from session / Access.
export const USER_ID = 'brian'

export function getUserPrefix(userId: string = USER_ID): string {
  return `assistant/${userId}`
}

export function getKey(collection: string, userId: string = USER_ID): string {
  return `${getUserPrefix(userId)}/${collection}`
}

/**
 * Get the R2 bucket binding.
 * Throws with actionable message if unavailable (common during misconfigured dev).
 */
export function getR2Bucket(): R2Bucket {
  const bucket = env.R2 as R2Bucket | undefined
  if (!bucket) {
    throw new Error(
      'R2 bucket binding "R2" is not available. ' +
        'Run with `npm run dev` (uses CF plugin) or `npm run dev:cf`. ' +
        'Ensure wrangler.jsonc defines an r2_buckets binding and you have created the bucket: ' +
        'npx wrangler r2 bucket create assistant-data'
    )
  }
  return bucket
}

/**
 * Read an object as text (or null if missing).
 */
export async function getObjectText(key: string): Promise<string | null> {
  const bucket = getR2Bucket()
  const obj = await bucket.get(key)
  if (!obj) return null
  return await obj.text()
}

/**
 * Read and JSON-parse. Returns null if missing or invalid.
 */
export async function getJSON<T>(key: string): Promise<T | null> {
  const text = await getObjectText(key)
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * Write string data to key. Use putJSON for objects.
 */
export async function putObject(
  key: string,
  data: string | ArrayBuffer | ReadableStream,
  options?: R2PutOptions
): Promise<void> {
  const bucket = getR2Bucket()
  await bucket.put(key, data, options)
}

/**
 * Write a JSON-serializable value.
 */
export async function putJSON<T>(key: string, value: T): Promise<void> {
  const json = JSON.stringify(value, null, 0)
  await putObject(key, json, {
    httpMetadata: { contentType: 'application/json' },
  })
}

/**
 * Delete an object.
 */
export async function deleteObject(key: string): Promise<void> {
  const bucket = getR2Bucket()
  await bucket.delete(key)
}

/**
 * List keys under a prefix (useful for future collections that use sharded keys).
 */
export async function listKeys(prefix: string): Promise<string[]> {
  const bucket = getR2Bucket()
  const listed = await bucket.list({ prefix })
  return listed.objects.map((o) => o.key)
}
