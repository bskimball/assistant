/**
 * Exercise silhouette endpoint: GET /api/exercise-image/{slug}?name=Bench%20press
 *
 * Serves the cached silhouette for an exercise, generating it on first miss via
 * Grok Imagine (see src/server/exercise-art.ts). The path slug is the cache key;
 * the `name` query gives the generator the human-readable movement. Returns 404
 * when art can't be produced (no API key / error) so the <img> falls back to a
 * placeholder client-side.
 */

import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/exercise-image/$slug")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { requireAuthSession } = await import("@/lib/auth");
        const { getOrCreateExerciseImage } = await import("@/server/exercise-art");
        const { slugifyExercise } = await import("@/lib/workout-phases");
        await requireAuthSession(request);

        const url = new URL(request.url);
        const name = (url.searchParams.get("name") || params.slug.replace(/-/g, " ")).slice(0, 80);
        const slug = slugifyExercise(params.slug || name);

        const image = await getOrCreateExerciseImage(slug, name);
        if (!image) {
          return new Response("No image", { status: 404 });
        }
        return new Response(image.data, {
          status: 200,
          headers: {
            "Content-Type": image.contentType,
            // Immutable once generated — silhouettes for a movement don't change.
            "Cache-Control": "public, max-age=2592000, immutable",
          },
        });
      },
    },
  },
});
