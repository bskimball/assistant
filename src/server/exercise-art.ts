/**
 * Exercise silhouette art (Grok Imagine).
 *
 * Generates a clean, single-color silhouette for an exercise the FIRST time it
 * is requested, caches the PNG bytes in R2, and serves the cached copy on every
 * subsequent request. So each unique exercise costs exactly one generation,
 * ever — not one per page load.
 *
 * Degrades gracefully (returns null) when no GROK_API_KEY is configured or the
 * image API errors, so the UI can fall back to a placeholder — same zero-config
 * contract as the rest of the coach.
 */

import { getGrokApiKey } from "@/server/adapters/ai";
import { getObjectBytes, getRefKey, putObject } from "@/server/adapters/r2";
import { asArrayBuffer, base64ToBytes } from "@/server/encoding";

const IMAGE_MODEL = "grok-imagine-image";
const DEFAULT_CONTENT_TYPE = "image/png";

function artKey(slug: string): string {
  // assistant/brian/exercise-art/{slug}.png
  return getRefKey(`exercise-art/${slug}.png`);
}

/**
 * Prompt tuned for a cohesive set: one light figure, dark slate backdrop, no
 * text or clutter. The UI always frames these on a dark tile so a single style
 * reads well in both light and dark mode.
 */
function buildPrompt(name: string): string {
  return (
    `A clean minimalist silhouette of a single athletic person performing the exercise "${name}". ` +
    `Solid light-gray figure, full body, centered, side or three-quarter view that clearly shows the movement. ` +
    `Flat modern fitness-app icon style on a smooth dark charcoal-slate background. ` +
    `High contrast, no text, no labels, no logos, no equipment branding, no border.`
  );
}

/** Call Grok Imagine and return image bytes + mime type, or null on failure. */
async function generate(name: string): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const apiKey = await getGrokApiKey();
  if (!apiKey) return null;
  try {
    const resp = await fetch("https://api.x.ai/v1/images/generations", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: IMAGE_MODEL,
        prompt: buildPrompt(name),
        n: 1,
        response_format: "b64_json",
      }),
    });
    if (!resp.ok) {
      console.warn("[exercise-art] image API HTTP", resp.status);
      return null;
    }
    const data: any = await resp.json();
    const item = data?.data?.[0];
    if (item?.b64_json) {
      return {
        data: asArrayBuffer(base64ToBytes(item.b64_json)),
        contentType: item.mime_type || DEFAULT_CONTENT_TYPE,
      };
    }
    // Some responses return a URL instead of inline base64.
    if (item?.url) {
      const img = await fetch(item.url);
      if (img.ok) {
        return {
          data: await img.arrayBuffer(),
          contentType: img.headers.get("content-type") || DEFAULT_CONTENT_TYPE,
        };
      }
    }
    return null;
  } catch (e) {
    console.warn("[exercise-art] generation failed", e);
    return null;
  }
}

/**
 * Return cached silhouette bytes for an exercise, generating + caching on first
 * miss. Returns null when generation isn't possible (no key / API error) so the
 * caller can serve a placeholder.
 */
export async function getOrCreateExerciseImage(
  slug: string,
  name: string,
): Promise<{ data: ArrayBuffer; contentType: string } | null> {
  const key = artKey(slug);

  const cached = await getObjectBytes(key);
  if (cached) {
    return { data: cached.data, contentType: cached.contentType || DEFAULT_CONTENT_TYPE };
  }

  const generated = await generate(name);
  if (!generated) return null;

  try {
    await putObject(key, generated.data, {
      httpMetadata: { contentType: generated.contentType },
    });
  } catch (e) {
    console.warn("[exercise-art] cache write failed", e);
  }
  return generated;
}
