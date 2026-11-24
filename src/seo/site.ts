/**
 * GEODESIA — SITE + CONTENT SOURCE OF TRUTH
 * ---------------------------------------------------------------------------
 * Every page, JSON-LD block, sitemap entry and social card reads from here so
 * titles, descriptions and canonical URLs can never drift apart.
 */

export const SITE = {
  name: 'Geodesia',
  legalName: 'Geodesia',
  domain: 'geodesia.online',
  url: 'https://geodesia.online',
  locale: 'en',
  lang: 'en',
  themeColor: '#0E1413',
  email: 'contact@geodesia.online',
  tagline: 'Land surveying instruments, computed in your browser.',
  description:
    'Free client-side land surveying instruments: elevation terrain profiles, polygon area from X/Y or latitude/longitude, and a land area unit converter. No login, no upload, no server — verified geodesic maths on WGS 84.',
  shortDescription:
    'Survey-grade elevation profiles, polygon area and land unit conversion — computed entirely in your browser.',
  founded: '2024',
  ogImage: '/og/geodesia-og.png',
  ogImageWidth: 1200,
  ogImageHeight: 630,
  ogImageAlt:
    'Geodesia — a graticule and terrain profile mark in basalt ink and vermilion on survey paper',
  keywords: [
    'land surveying tools',
    'terrain profile generator',
    'elevation profile from coordinates',
    'polygon area calculator',
    'land area calculator',
    'shoelace formula area',
    'geodesic area WGS84',
    'land unit converter',
    'hectares to acres',
    'gunta to acre',
    'rood to acre',
    'slope gradient calculator',
    'cadastral area calculator',
    'survey calculator online',
  ],
} as const;

/* ------------------------------------------------------------------ tools */

export type ToolId = 'terrain' | 'polygon' | 'converter';

export interface ToolDef {
  id: ToolId;
  /** Route without trailing slash, e.g. '/terrain-profile'. */
  path: string;
  name: string;
  shortName: string;
  eyebrow: string;
  metaTitle: string;
  metaDescription: string;
  h1: string;
  lede: string;
  keywords: string[];
  /** One-line description used in cards, sitemap and schema. */
  blurb: string;
}

export const TOOLS: Record<ToolId, ToolDef> = {
  terrain: {
    id: 'terrain',
    path: '/terrain-profile',
    name: 'Terrain Profile',
    shortName: 'Profile',
    eyebrow: 'Instrument 01 · Elevation',
    metaTitle: 'Terrain Profile Generator — Draw on a Satellite Map | Geodesia',
    metaDescription:
      'Draw a line on satellite imagery, or switch to Terrain, and get an elevation cross-section with climb, descent, gradient and slope class, in your browser.',
    h1: 'Terrain profile generator for elevation cross-sections',
    lede:
      'Pick two points on the map, draw a route, or load a survey sheet — Geodesia samples the ground along your line and returns a cross-section with climb, descent, gradient and slope classification. Every figure is traceable to a station in the table.',
    keywords: [
      'terrain profile generator',
      'elevation cross section tool',
      'elevation profile from coordinates',
      'elevation gain calculator',
      'slope gradient calculator',
      'route elevation profile',
      'DEM profile online',
    ],
    blurb:
      'Elevation cross-sections from two map clicks, a drawn route or an uploaded survey sheet, with climb, descent, gradient and slope class.',
  },
  polygon: {
    id: 'polygon',
    path: '/polygon-area',
    name: 'Polygon Area & Coordinate Engine',
    shortName: 'Area',
    eyebrow: 'Instrument 02 · Area',
    metaTitle: 'Polygon Area Calculator — Area on a Satellite Map | Geodesia',
    metaDescription:
      'Draw or paste a boundary on satellite imagery: grid, geodesic and ground area from UTM, X/Y or lat/long, with closure and per-leg checks, in your browser.',
    h1: 'Parcel area from UTM, local grid or geographic coordinates',
    lede:
      'Paste the boundary exactly as it came off the instrument — UTM eastings and northings, a local X/Y grid, or WGS 84 latitude and longitude in decimal or DMS — and Geodesia returns the grid, geodesic and ground areas with every leg checked.',
    keywords: [
      'polygon area calculator',
      'UTM area calculator',
      'area from utm coordinates',
      'land area calculator coordinates',
      'shoelace formula calculator',
      'geodesic area WGS84',
      'grid area ground area CSF',
      'cadastral area calculator',
      'hectares acres square feet',
    ],
    blurb:
      'Parcel area from UTM, X/Y or lat/long: grid, geodesic and ground surfaces, per-leg checks, closure and a full unit breakdown.',
  },
  converter: {
    id: 'converter',
    path: '/land-unit-converter',
    name: 'Land Area Unit Converter',
    shortName: 'Converter',
    eyebrow: 'Instrument 03 · Units',
    metaTitle: 'Land Area Unit Converter — Hectares, Acres, Guntas | Geodesia',
    metaDescription:
      'Convert land area between m², hectares, ares, km², ft², yd², acres, square miles, roods, guntas and decimals — exact factors and every unit at once.',
    h1: 'Land area unit converter for cadastral and agricultural parcels',
    lede:
      'One value in, every unit out. Exact factors, grouped by metric, imperial and cadastral practice, with the Kenyan agricultural units (gunta, rood, decimal) surveyors actually quote to clients.',
    keywords: [
      'land area unit converter',
      'hectares to acres',
      'gunta to acre',
      'rood to acre',
      'square metres to hectares',
      'decimal to square feet',
      'acres to square metres',
      'cadastral unit conversion',
    ],
    blurb:
      'Every land unit at once — metric, imperial and Kenyan cadastral/agricultural — with exact factors and a dimensions helper.',
  },
};

export const TOOL_ORDER: ToolId[] = ['terrain', 'polygon', 'converter'];

/* ------------------------------------------------------------- ecosystem */

export interface EcosystemApp {
  id: string;
  name: string;
  /** Previous or internal name, shown as an alias when the live brand differs. */
  aka?: string;
  host: string;
  url: string;
  status: 'LIVE' | 'BETA' | 'CORE';
  statusLabel: string;
  execution: string;
  description: string;
  tags: string[];
  internal: boolean;
  cta: string;
  /** Route for internal apps. */
  path?: string;
}

export const ECOSYSTEM: EcosystemApp[] = [
  {
    id: 'core',
    name: 'Geodesia Core',
    host: 'geodesia.online',
    url: 'https://geodesia.online',
    status: 'CORE',
    statusLabel: 'LIVE',
    execution: 'Client-Side Execution',
    description:
      'The instrument bench you are on: terrain profiles, polygon area from coordinates, and land unit conversion. Deterministic geodesic maths, computed locally, exportable as CSV, JSON or a PDF field report.',
    tags: ['Terrain profile', 'Polygon area', 'Unit converter'],
    internal: true,
    cta: 'Open workspace',
    path: '/terrain-profile',
  },
  {
    id: 'landiq',
    name: 'TerraFact',
    aka: 'Land IQ',
    host: 'landiq.geodesia.online',
    url: 'https://landiq.geodesia.online',
    status: 'BETA',
    statusLabel: 'BETA',
    execution: 'Client-Side Execution',
    description:
      'AI-assisted crop suitability on browser-local Cloud Optimized GeoTIFFs. Clip a parcel polygon against a COG raster, sample the bands and score the land against a crop profile — the imagery never leaves the machine.',
    tags: ['COG / GeoTIFF', 'Spatial clipping', 'Crop suitability'],
    internal: false,
    cta: 'Open TerraFact',
  },
  {
    id: 'methodflow',
    name: 'MethodFlow',
    host: 'methodflow.geodesia.online',
    url: 'https://methodflow.geodesia.online',
    status: 'LIVE',
    statusLabel: 'LIVE',
    execution: 'Client-Side Execution',
    description:
      'Thesis-standard research methodology diagrams. Compose the flow, then export a publication-grade LaTeX (TikZ) figure, an editable Word document, or Mermaid source for the appendix.',
    tags: ['LaTeX / TikZ', 'Word export', 'Mermaid'],
    internal: false,
    cta: 'Open MethodFlow',
  },
];

/* ------------------------------------------------------------------ routes */

export interface NavItem {
  label: string;
  href: string;
  kind: 'primary' | 'tool' | 'meta';
}

export const NAV: NavItem[] = [
  { label: 'Workspace', href: '/#workspace', kind: 'primary' },
  { label: 'Terrain Profile', href: '/terrain-profile', kind: 'tool' },
  { label: 'Polygon Area', href: '/polygon-area', kind: 'tool' },
  { label: 'Unit Converter', href: '/land-unit-converter', kind: 'tool' },
  { label: 'About', href: '/about', kind: 'meta' },
];

/** Indexable routes, used by the sitemap and by static link Q/A. */
export const ROUTES: Array<{ path: string; priority: number; changefreq: string }> = [
  { path: '/', priority: 1, changefreq: 'weekly' },
  { path: '/terrain-profile', priority: 0.9, changefreq: 'monthly' },
  { path: '/polygon-area', priority: 0.9, changefreq: 'monthly' },
  { path: '/land-unit-converter', priority: 0.8, changefreq: 'monthly' },
  { path: '/about', priority: 0.4, changefreq: 'yearly' },
];

/* ------------------------------------------------------------ engineering */

/** Datum + method statements reused in copy and JSON-LD. */
export const ENGINE = {
  name: 'Geodesia',
  datum: 'WGS 84',
  ellipsoid: 'WGS 84 (a = 6 378 137 m, 1/f = 298.257223563)',
  projection: 'UTM — WGS 84 transverse Mercator, zone 1–60, hemisphere-aware, FE 500 000 m, FN 10 000 000 m south, k0 = 0.9996',
  areaMethods: [
    'Grid area: Gaussian shoelace (planar trapezoid) on projected X/Y or UTM coordinates in metres',
    'Geodesic area: ellipsoidal polygon area on WGS 84 (Karney series)',
    'Ground area: grid area reduced by the combined scale factor, CSF = k · EF',
  ],
  distanceMethods:
    'Inverse geodesic on WGS 84 for the ellipsoidal surface; planar distance and grid bearing on projected UTM or X/Y coordinates',
  runtime: 'Browser (client-side; no data leaves the device)',
  basemap:
    'Three cached raster layers, each with its own ordered fallback chain: Satellite (Esri World Imagery, default, with an optional place and boundary label overlay), Terrain (Thunderforest styling over OpenStreetMap data via the Geodesia edge, then Esri World Topographic, OpenTopoMap and OSM) and Streets (CARTO Voyager, then OSM); tiles are cached at the Geodesia edge where they pass through it and again in the browser by a service worker',
  exports: ['CSV', 'JSON (schema geodesia.report/v1)', 'PDF field report (pdf-lib)'],
} as const;

/** Human-readable statement of the tool contract shown in footers. */
export const DISCLAIMER =
  'Geodesia computes with published geodesic formulae for planning, verification and coursework. It is not a substitute for a licensed surveyor’s adjudicated boundary survey.';

export const COPYRIGHT_YEAR = 2026;
