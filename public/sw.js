/* ==========================================================================
   GEODESIA — SERVICE WORKER
   --------------------------------------------------------------------------
   Two caches, both bounded:

     geodesia-tiles-v<N>   map tiles from the Geodesia edge service and its
                           fallbacks. Tiles are immutable at the edge, so
                           cache-first is correct; a hard cap keeps a heavy
                           user from filling their disk.
     geodesia-assets-v<N>  same-origin build assets (hashed, immutable) and
                           icons/brand files.

   HTML navigations are network-first so a deploy is picked up immediately,
   falling back to cache when offline.

   This is what makes a repeated visit to a tool cost almost no tile traffic:
   the browser answers from disk before the network is asked at all.
   ========================================================================== */

const VERSION = 'v4';
const TILE_CACHE = `geodesia-tiles-${VERSION}`;
const ASSET_CACHE = `geodesia-assets-${VERSION}`;
const MAX_TILES = 1500;
const MAX_ASSETS = 120;

const TILE_HOSTS = new Set([
  'geodesia-proxy.254konzani.workers.dev',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'a.tile.openstreetmap.org',
  'b.tile.openstreetmap.org',
  'c.tile.openstreetmap.org',
]);

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter((key) => key !== TILE_CACHE && key !== ASSET_CACHE)
          .map((key) => caches.delete(key)),
      );
      await self.clients.claim();
    })(),
  );
});

/** Add a response to a cache, keeping the cache under `limit` entries. */
async function putBounded(cacheName, request, response, limit) {
  try {
    const cache = await caches.open(cacheName);
    await cache.put(request, response);
    const keys = await cache.keys();
    if (keys.length > limit) {
      const excess = keys.length - limit;
      for (let i = 0; i < excess; i += 1) {
        await cache.delete(keys[i]);
      }
    }
  } catch {
    /* quota or opaque failure — caching is best-effort, never fatal */
  }
}

function isCacheable(response) {
  if (!response) return false;
  if (response.status === 200) return true;
  // Cross-origin tiles come back as opaque responses (status 0) — still cacheable.
  return response.type === 'opaque';
}

async function cacheFirst(request, cacheName, limit) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request);
  if (hit) return hit;
  const response = await fetch(request);
  if (isCacheable(response)) {
    await putBounded(cacheName, request, response.clone(), limit);
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(ASSET_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.status === 200) {
      await putBounded(ASSET_CACHE, request, response.clone(), MAX_ASSETS);
    }
    return response;
  } catch (error) {
    const hit = await cache.match(request);
    if (hit) return hit;
    throw error;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // 1. map tiles (cross-origin, immutable at the edge)
  if (TILE_HOSTS.has(url.hostname)) {
    event.respondWith(cacheFirst(request, TILE_CACHE, MAX_TILES));
    return;
  }

  // 2. same-origin only from here down
  if (url.origin !== self.location.origin) return;

  // 3. hashed build assets + brand files: cache-first
  if (url.pathname.startsWith('/_assets/') || url.pathname.startsWith('/brand/') || url.pathname.startsWith('/og/')) {
    event.respondWith(cacheFirst(request, ASSET_CACHE, MAX_ASSETS));
    return;
  }

  // 4. navigations: network-first so deploys land immediately
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request));
    return;
  }

  // 5. everything else same-origin: network, cache fallback
  event.respondWith(
    (async () => {
      try {
        return await fetch(request);
      } catch (error) {
        const cache = await caches.open(ASSET_CACHE);
        const hit = await cache.match(request);
        if (hit) return hit;
        throw error;
      }
    })(),
  );
});

// Let the page ask how much is cached (used by the map status line / QA).
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'geodesia-cache-stats') {
    event.waitUntil(
      (async () => {
        const tiles = await caches.open(TILE_CACHE);
        const assets = await caches.open(ASSET_CACHE);
        const stats = {
          type: 'geodesia-cache-stats',
          tiles: (await tiles.keys()).length,
          assets: (await assets.keys()).length,
          version: VERSION,
        };
        if (event.source) event.source.postMessage(stats);
      })(),
    );
  }
});
