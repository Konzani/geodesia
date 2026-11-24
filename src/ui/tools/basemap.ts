/**
 * GEODESIA â€” BASEMAP LAYERS, TILE SOURCES AND ELEVATION ENDPOINTS
 * ---------------------------------------------------------------------------
 * One place to change where map tiles and elevation samples come from.
 *
 * Three layers, each with its own ordered provider chain and its own
 * attribution, so the user can pick the map that suits the job:
 *
 *   satellite  high-resolution aerial imagery (Esri World Imagery). Field
 *              boundaries, plots, buildings, fences and tracks are legible
 *              from roughly zoom 16 and sharp by 18-19 â€” this is the layer
 *              for cadastral and land-area work. A transparent label overlay
 *              (Esri boundaries + places) can be switched on for orientation.
 *   terrain    shaded topographic cartography. The Geodesia edge worker
 *              (Thunderforest styling) answers first; Esri World Topographic,
 *              OpenTopoMap and OpenStreetMap are the fallbacks.
 *   streets    clean street cartography for wayfinding (CARTO Voyager â†’ OSM).
 *
 * Primary tile host for the terrain layer is the Geodesia edge tile service
 * (Cloudflare Worker):
 *   `https://geodesia-proxy.254konzani.workers.dev/tiles/{z}/{x}/{y}`
 *   â€¢ cached at Cloudflare's edge for a year (`Cache-Control: immutable`), which
 *     is what keeps the origin (and the provider's quota) out of the hot path
 *   â€¢ CORS `*`, so it works from any geodesia.online subdomain
 *   â€¢ no per-view quota imposed by us â€” the worker is the throttle, not a
 *     third-party CDN with a free-tier cap in front of the user
 *
 * Every provider is raster PNG/JPEG at 256 px, so Leaflet is enough and no
 * WebGL is required. `public/sw.js` caches tiles locally on top of this so a
 * returning user browses from their own disk.
 *
 * To go fully self-hosted later: point the first entry of any chain at your own
 * tiles (mbtiles â†’ tiles.php, or a PMTiles/vector host) and leave the rest of
 * the chain untouched.
 */

export type BasemapLayerId = 'satellite' | 'terrain' | 'streets';

export interface TileProvider {
  id: string;
  /** Short label for the map status line. */
  label: string;
  /** Leaflet URL template, 256 px tiles. */
  url: string;
  /** Required attribution text, shown in the Leaflet control. */
  attribution: string;
  /** Highest zoom Leaflet will request (beyond `maxNativeZoom` tiles are upscaled). */
  maxZoom: number;
  /** Highest zoom the server actually renders; absent means equal to `maxZoom`. */
  maxNativeZoom?: number;
  subdomains?: string;
  /** True for the Geodesia edge service (no third-party quota in the path). */
  primary?: boolean;
}

export interface BasemapLayer {
  id: BasemapLayerId;
  /** Compact switcher label (one word). */
  label: string;
  /** Full name for the status pill and tooltips. */
  title: string;
  /** One-line description shown as the switcher tooltip. */
  hint: string;
  providers: readonly TileProvider[];
  /** Optional transparent label overlay drawn on top of every provider. */
  overlay?: TileProvider;
}

/** Transparent boundaries + place/road labels drawn over satellite imagery. */
const ESRI_LABEL_OVERLAY: TileProvider = {
  id: 'esri-labels',
  label: 'Esri place labels',
  url: 'https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  attribution:
    'Labels Â© <a href="https://www.esri.com/" rel="noopener" target="_blank">Esri</a>, HERE, Garmin, OpenStreetMap contributors',
  maxZoom: 21,
  maxNativeZoom: 19,
};

const ESRI_IMAGERY: TileProvider = {
  id: 'esri-imagery',
  label: 'Esri World Imagery',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  attribution:
    'Imagery Â© <a href="https://www.esri.com/" rel="noopener" target="_blank">Esri</a>, Maxar, Earthstar Geographics, and the GIS User Community',
  maxZoom: 21,
  maxNativeZoom: 19,
  primary: true,
};

const ESRI_TOPO: TileProvider = {
  id: 'esri-topo',
  label: 'Esri World Topographic',
  url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}',
  attribution:
    'Tiles Â© <a href="https://www.esri.com/" rel="noopener" target="_blank">Esri</a> â€” Esri, HERE, Garmin, USGS, NGA, and the GIS user community',
  maxZoom: 19,
};

const OPEN_TOPO: TileProvider = {
  id: 'opentopomap',
  label: 'OpenTopoMap',
  url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
  attribution:
    'Map data Â© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors, SRTM Â· Style Â© <a href="https://opentopomap.org" rel="noopener" target="_blank">OpenTopoMap</a> (CC-BY-SA)',
  maxZoom: 17,
  subdomains: 'abc',
};

const OSM: TileProvider = {
  id: 'osm',
  label: 'OpenStreetMap',
  url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    'Â© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors',
  maxZoom: 19,
};

const GEODESIA_EDGE: TileProvider = {
  id: 'geodesia-edge',
  label: 'Geodesia edge cache',
  url: 'https://geodesia-proxy.254konzani.workers.dev/tiles/{z}/{x}/{y}',
  attribution:
    'Maps Â© <a href="https://www.thunderforest.com/" rel="noopener" target="_blank">Thunderforest</a> Â· Data Â© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors Â· cached at the Geodesia edge',
  maxZoom: 18,
  primary: true,
};

const CARTO_VOYAGER: TileProvider = {
  id: 'carto-voyager',
  label: 'CARTO Voyager',
  url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png',
  attribution:
    'Â© <a href="https://www.openstreetmap.org/copyright" rel="noopener" target="_blank">OpenStreetMap</a> contributors Â© <a href="https://carto.com/attributions" rel="noopener" target="_blank">CARTO</a>',
  maxZoom: 20,
  subdomains: 'abcd',
};

export const BASEMAP_LAYERS: Record<BasemapLayerId, BasemapLayer> = {
  satellite: {
    id: 'satellite',
    label: 'Satellite',
    title: 'Satellite imagery',
    hint: 'High-resolution aerial imagery â€” field boundaries, plots and buildings at zoom 16+.',
    providers: [ESRI_IMAGERY, ESRI_TOPO, OSM],
    overlay: ESRI_LABEL_OVERLAY,
  },
  terrain: {
    id: 'terrain',
    label: 'Terrain',
    title: 'Terrain map (Geodesia edge)',
    hint: 'Shaded topographic map â€” contours, rivers and land use.',
    providers: [GEODESIA_EDGE, ESRI_TOPO, OPEN_TOPO, OSM],
  },
  streets: {
    id: 'streets',
    label: 'Streets',
    title: 'Street map',
    hint: 'Clean street cartography for wayfinding and access roads.',
    providers: [CARTO_VOYAGER, OSM],
  },
};

/** Switcher order, left to right. */
export const BASEMAP_LAYER_ORDER: readonly BasemapLayerId[] = ['satellite', 'terrain', 'streets'];

/** Layer opened on a first visit. Imagery, because plot boundaries are the job. */
export const DEFAULT_BASEMAP_LAYER: BasemapLayerId = 'satellite';

/** Labels are on by default over imagery: non-technical users orient faster. */
export const DEFAULT_SHOW_LABELS = true;

/** The default layer's provider chain (kept as a named export for the QA tests). */
export const TILE_PROVIDERS: readonly TileProvider[] = BASEMAP_LAYERS[DEFAULT_BASEMAP_LAYER].providers;

/** All providers across all layers, for tests and CSP bookkeeping. */
export function allBasemapProviders(): readonly TileProvider[] {
  return BASEMAP_LAYER_ORDER.flatMap((id) => {
    const layer = BASEMAP_LAYERS[id];
    const providers = [...layer.providers];
    if (layer.overlay) providers.push(layer.overlay);
    return providers;
  });
}

/** Resolve a layer id defensively (stored preference, older builds). */
export function resolveBasemapLayer(value: unknown): BasemapLayerId {
  return typeof value === 'string' && value in BASEMAP_LAYERS ? (value as BasemapLayerId) : DEFAULT_BASEMAP_LAYER;
}

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
  'services.arcgisonline.com',
  'basemaps.cartocdn.com',
  'a.basemaps.cartocdn.com',
  'b.basemaps.cartocdn.com',
  'c.basemaps.cartocdn.com',
  'd.basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'a.tile.opentopomap.org',
  'b.tile.opentopomap.org',
  'c.tile.opentopomap.org',
  'api.open-meteo.com',
];

/** 1Ã—1 transparent PNG â€” assigned to `errorTileUrl` so failed tiles never show a broken icon. */
export const TRANSPARENT_TILE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
