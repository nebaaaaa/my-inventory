// =====================================================================
// MELEYA / Service Worker
// Caches the app shell so the app OPENS instantly with no internet or a
// very weak one. Supabase data is never cached (always straight to network).
//
// Whenever you replace index.html (or any file listed below), bump
// CACHE_NAME ('v32' -> 'v33'). That is what tells every installed copy
// "a new version is ready".
// =====================================================================

const CACHE_NAME = 'meleya-shell-v44';

// MUST all download successfully, or this version does NOT install and the
// phone keeps running the previous working version (retrying later).
// This is what prevents a half-saved release -> blank page.
const CORE_ASSETS = [
  './business-types.config.js',
  './vendor/supabase.js'
];

// Nice to have offline; a failure here does not block the install.
const OPTIONAL_ASSETS = [
  './verticals/pharmacy.js',
  './verticals/rental.js',
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.5.1',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.117.2'
];

// If the network has not even started answering after this long, give up
// instead of leaving the page waiting forever (a blocking <script> that
// never answers = blank white page).
const NETWORK_TIMEOUT_MS = 8000;

function fetchWithTimeout(request, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(request, { signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);

    // index.html is big: download it ONCE and store it under both addresses.
    // 'no-cache' = ask the server "changed?" and reuse the copy the browser just downloaded if not,
    // so a first visit on a slow connection does not have to download the big page twice.
    const page = await fetch(new Request('./index.html', { cache: 'no-cache' }));
    if (!page.ok) throw new Error('index.html not available');
    await cache.put('./index.html', page.clone());
    await cache.put('./', page);

    // Core files: any failure rejects -> install aborts -> old version stays.
    await Promise.all(CORE_ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' }))));

    // Optional files: best effort.
    await Promise.all(OPTIONAL_ASSETS.map((u) => cache.add(new Request(u, { cache: 'reload' })).catch(() => { })));
  })());
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
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.url.includes('supabase.co')) return; // shop data: always live
  if (req.url.includes('/api/')) return;       // serverless functions: always live

  // Opening the app: ALWAYS the saved copy, instantly. No background
  // re-download of the 1.3 MB page on every launch (that fights for a weak
  // connection and could mix versions). New versions arrive through the
  // CACHE_NAME bump above.
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match(req, { ignoreSearch: true })
        .then((hit) => hit || caches.match('./index.html'))
        .then((hit) => hit || caches.match('./'))
        .then((hit) => hit || fetch(req).then((response) => {
          // Nothing saved yet (first visit, or an install that has not finished): keep this copy
          // so the next opening is instant even on a very weak connection.
          if (response && response.status === 200) {
            const clone = response.clone();
            event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put('./index.html', clone)).catch(() => { }));
          }
          return response;
        }))
    );
    return;
  }

  // Everything else (scripts, styles, fonts, vertical modules): saved copy
  // first; if not saved yet, try the network but never wait forever.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetchWithTimeout(req, NETWORK_TIMEOUT_MS).then((response) => {
        if (response && response.status === 200) {
          const clone = response.clone();
          event.waitUntil(caches.open(CACHE_NAME).then((c) => c.put(req, clone)).catch(() => { }));
        }
        return response;
      });
    })
  );
});
