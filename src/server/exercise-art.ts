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

import { getGrokApiKey, GROK_MODELS } from "@/server/adapters/ai";
import { getObjectBytes, getRefKey, putObject } from "@/server/adapters/r2";
import { asArrayBuffer, base64ToBytes } from "@/server/encoding";

const DEFAULT_CONTENT_TYPE = "image/png";

// Bump when the art STYLE changes so cached images regenerate instead of
// serving the old look. v2 = realistic photography (was v1 flat silhouettes).
const ART_STYLE_VERSION = "v2";

function artKey(slug: string): string {
  // assistant/brian/exercise-art/{style}/{slug}.png
  return getRefKey(`exercise-art/${ART_STYLE_VERSION}/${slug}.png`);
}

/**
 * Prompt tuned for a cohesive set of warm, inviting exercise PHOTOGRAPHY. One
 * real person mid-movement in soft natural light, calm neutral studio/home
 * setting, shallow depth of field. The UI frames these edge-to-edge (object-
 * cover) so the photo fills the tile in both themes.
 */
function buildPrompt(name: string): string {
  return (
    `A warm, high-end fitness photograph of a single athletic person performing the exercise "${name}". ` +
    `Real human, full or three-quarter body, side or three-quarter view that clearly shows the movement. ` +
    `Soft natural morning light, calm minimalist home-gym or studio setting with warm neutral tones, ` +
    `shallow depth of field, gentle film-like color grade, editorial wellness magazine aesthetic. ` +
    `Centered composition suitable for a square crop. No text, no labels, no logos, no watermarks, no borders.`
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
        model: GROK_MODELS.image,
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
