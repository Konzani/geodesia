/**
 * GEODESIA — BASEMAP + ELEVATION SOURCES
 * ---------------------------------------------------------------------------
 * One place to change where map tiles and elevation samples come from.
 *
 * Primary basemap: the Geodesia edge tile service (Cloudflare Worker) —
 *   `https://geodesia-proxy.254konzani.workers.dev/tiles/{z}/{x}/{y}`
 *   • Thunderforest topo styling with OpenStreetMap data
 *   • cached at Cloudflare's edge for a year (`Cache-Control: immutable`), which
 *     is what keeps the origin (and the provider's quota) out of the hot path
 *   • CORS `*`, so it works from any geodesia.online subdomain
 *   • no per-view quota imposed by us — the worker is the throttle, not a
 *     third-party CDN with a free-tier cap in front of the user
 *
 * Fallbacks run in order if the edge service is unavailable (worker down, key
 * rotation, offline). Every provider is raster PNG/JPEG at 256 px, so Leaflet is
 * enough and no WebGL is required. `public/sw.js` caches tiles locally on top of
 * this so a returning user browses from their own disk.
 *
 * To go fully unlimited / self-hosted later: point `TILE_PROVIDERS[0].url` at
 * your own tiles (mbtiles → tiles.php, or a PMTiles/vector host) and leave the
 * rest of the chain untouched.
 */

export interface TileProvider {
  id: string;
  /** Short label for the map status line. */
  label: string;
  /** Leaflet URL template, 256 px tiles. */
  url: string;
  /** Required attribution text, shown in the Leaflet control. */
  attribution: string;
  maxZoom: number;
  subdomains?: string;
  /** True for the Geodesia edge service (no third-party quota in the path). */
  primary?: boolean;
}

export const TILE_PROVIDERS: readonly TileProvider[] = [
  {
    id: 'geodesia-edge',
    label: 'Geodesia edge cache',
    url: 'https://geodesia-proxy.254konzani.workers.dev/tiles/{z}/{x}/{y}',
    attribution:
      'Maps © <a href="https://www.thunderforest.com/" rel="noopener" target="_blank">Thunderforest</a> · Data © <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors · cached at the Geodesia edge',
    maxZoom: 18,
    primary: true,
  },
  {
    id: 'esri-topo',
    label: 'Esri World Topographic',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
    attribution:
      'Tiles © <a href="https://www.esri.com/" rel="noopener" target="_blank">Esri</a> — Esri, HERE, Garmin, USGS, NGA, and the GIS user community',
    maxZoom: 19,
  },
  {
    id: 'carto-light',
    label: 'CARTO Positron',
    url: 'https://basemaps.cartocdn.com/rastertiles/light_all/{z}/{x}/{y}{r}.png',
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors © <a href="https://carto.com/attributions" rel="noopener" target="_blank">CARTO</a>',
    maxZoom: 20,
    subdomains: 'abcd',
  },
  {
    id: 'osm',
    label: 'OpenStreetMap',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution:
      '© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors',
    maxZoom: 19,
  },
];

/** Default map view: Kenya, so cadastral/agricultural work starts in frame. */
export const MAP_DEFAULT_VIEW = {
  center: { lat: -0.45, lon: 37.55 },
  zoom: 6,
} as const;

/**
 * Elevation services, tried in order. Both return the same shape:
 * `{ elevation: number[] }` for comma-separated latitude/longitude parameters,
 * max 100 coordinates per request.
 */
export const ELEVATION_ENDPOINTS: readonly string[] = [
  'https://geodesia-proxy.254konzani.workers.dev/elevation',
  'https://api.open-meteo.com/v1/elevation',
];

/** Every host the map or elevation fetcher may contact (used by the CSP + tests). */
export const BASEMAP_HOSTS: readonly string[] = [
  'geodesia-proxy.254konzani.workers.dev',
  'server.arcgisonline.com',
  'basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'api.open-meteo.com',
];

/** 1×1 transparent PNG — assigned to `errorTileUrl` so failed tiles never show a broken icon. */
export const TRANSPARENT_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
