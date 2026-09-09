// =====================================================================
// MELEYA — Service Worker
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

const CACHE_NAME = 'meleya-shell-v16';

const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './business-types.config.js',
  // Vertical modules (business-types.config.js -> loadVerticalModule) are
  // fetched separately via a dynamic import() the first time a tenant of
  // that business type logs in -- if that first login happens offline (or
  // simply before this list existed), the file is never cached and that
  // vertical's features silently never appear. Precaching them here up
  // front means every business type works offline from the very first
  // launch, not just after one lucky online login. Add a line here
  // whenever a new vertical file is added to verticals/.
  './verticals/pharmacy.js',
  './verticals/appliance_rental.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS_TO_CACHE))
      .catch(() => { /* fine if a CDN asset fails to pre-cache; it'll be cached on first successful fetch instead */ })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Never cache Supabase API traffic — your shop data must always be
  // fetched fresh, never served from a stale local cache.
  if (event.request.url.includes('supabase.co')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response && response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached); // offline and not cached yet — nothing more we can do for this request

      // Cache-first: show the saved copy instantly if we have one, while
      // quietly checking the network in the background for next time.
      return cached || networkFetch;
    })
  );
});