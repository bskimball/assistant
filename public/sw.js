/*
 * Compass service worker.
 *
 * Deliberately conservative: this is an auth-gated SSR app whose pages and
 * server functions are user-specific and must never be served stale. So:
 *   - HTML navigations  -> network-first, falling back to a cached offline page
 *   - API / server fns  -> never touched (pass straight through to network)
 *   - static assets     -> cache-first (Vite emits content-hashed, immutable URLs)
 *
 * Bump CACHE_VERSION to force every client to drop old caches on activate.
 */
const CACHE_VERSION = "v4";
const STATIC_CACHE = `compass-static-${CACHE_VERSION}`;
const ASSET_CACHE = `compass-assets-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";

// App shell precached on install so the offline fallback always works.
const PRECACHE_URLS = [
  OFFLINE_URL,
  "/compass.svg",
  "/favicon.svg",
  "/favicon.ico",
  "/logo192.png",
  "/logo512.png",
  "/manifest.json",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== STATIC_CACHE && key !== ASSET_CACHE)
            .map((key) => caches.delete(key)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

// Let the page trigger an immediate activation after an update.
self.addEventListener("message", (event) => {
  if (event.data === "SKIP_WAITING") self.skipWaiting();
});

function isStaticAsset(url, request) {
  if (url.pathname.startsWith("/assets/")) return true;
  const dest = request.destination;
  return dest === "style" || dest === "script" || dest === "font" || dest === "image";
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // Same-origin only; let the browser handle cross-origin (CDNs, OAuth, avatars).
  if (url.origin !== self.location.origin) return;

  // Never intercept dynamic/server traffic — auth, server functions, APIs.
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.startsWith("/_serverFn") ||
    url.pathname.includes("/_server")
  ) {
    return;
  }

  // HTML navigations: network-first, fall back to the offline shell.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => {
        const cache = await caches.open(STATIC_CACHE);
        return (await cache.match(OFFLINE_URL)) || Response.error();
      }),
    );
    return;
  }

  // Content-hashed static assets: cache-first, revalidate misses into the cache.
  if (isStaticAsset(url, request)) {
    event.respondWith(
      caches.open(ASSET_CACHE).then(async (cache) => {
        const cached = await cache.match(request);
        if (cached) return cached;
        const response = await fetch(request);
        if (response.ok && response.type === "basic") {
          cache.put(request, response.clone());
        }
        return response;
      }),
    );
  }
});
