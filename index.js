// =====================================================================
// NEBA ERP — Service Worker
// Caches the app shell (this HTML file + its library files) so the app
// can still OPEN with no internet connection. This does NOT cache your
// actual shop data — every request to Supabase always goes straight to
// the network, since Supabase is the one true source of your data.
//
// IMPORTANT: whenever you replace index.html with a newer version,
// bump CACHE_NAME below (e.g. 'v1' -> 'v2') so returning users get the
// new version instead of a stuck old copy. If you forget, people may
// keep seeing the old app until the cache naturally expires.
// =====================================================================

const CACHE_NAME = "neba-erp-shell-v8";

// The app itself — these MUST be cached or offline opening is impossible.
const CORE_ASSETS = ["./", "./index.html"];
// Third-party libraries — nice to have cached, but a hiccup fetching one
// of these should never be allowed to block the core assets above.
const LIBRARY_ASSETS = [
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js",
  "https://cdn.jsdelivr.net/npm/chart.js",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Cache every asset individually (not cache.addAll, which is
      // all-or-nothing — one failed fetch would silently wipe out the
      // whole batch, including index.html itself).
      const cacheOne = (url) =>
        cache
          .add(url)
          .catch((err) => console.warn("Pre-cache failed for", url, err));
      await Promise.all(CORE_ASSETS.map(cacheOne));
      await Promise.all(LIBRARY_ASSETS.map(cacheOne));
    }),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)),
        ),
      ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Never cache Supabase API traffic — your shop data must always be
  // fetched fresh, never served from a stale local cache.
  if (event.request.url.includes("supabase.co")) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches
              .open(CACHE_NAME)
              .then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(async () => {
          if (cached) return cached;
          // Offline, nothing cached under this exact URL — for a page
          // navigation, fall back to the cached app shell itself rather
          // than letting the browser show its own "no internet" page.
          if (event.request.mode === "navigate") {
            return (
              (await caches.match("./index.html")) || (await caches.match("./"))
            );
          }
          return undefined;
        });

      // Cache-first: show the saved copy instantly if we have one, while
      // quietly checking the network in the background for next time.
      return cached || networkFetch;
    }),
  );
});
