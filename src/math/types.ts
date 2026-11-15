/**
 * GEODESIA — MATHEMATICAL CORE CONTRACT
 * ---------------------------------------------------------------------------
 * This file is the frozen public surface of `/src/math/`. UI and export code
 * must code against these types and signatures only.
 *
 * Conventions
 *  - Coordinates: WGS 84 geographic in DEGREES (lat = +north, lon = +east).
 *  - Local Cartesian (`XYPoint`): metres, arbitrary origin, x = easting-like.
 *  - Angles: degrees unless a name says `rad`.
 *  - Areas: square metres unless a field name says otherwise.
 *  - All functions are pure and throw `Error` with human-readable messages on
 *    invalid input. No DOM, no network, no globals.
 *
 * NOTE: declarations here are ambient (`declare`) — this module carries types
 * only. Runtime implementations live in the sibling modules and are re-exported
 * from `src/math/index.ts`.
 */

/** WGS 84 geographic position in decimal degrees. */
export interface LatLon {
  lat: number;
  lon: number;
}

/** Local projected/cartesian position in metres. */
export interface XYPoint {
  x: number;
  y: number;
}

/** A vertex that may be either geographic or Cartesian (used by the polygon tool). */
export type Vertex = LatLon | XYPoint;

/** Distance unit descriptor. */
export type LengthUnit = 'm' | 'km' | 'ft' | 'mi' | 'nm';

/** Land-area unit conversions for one magnitude expressed in m². */
export interface AreaUnits {
  m2: number;
  ha: number;
  acres: number;
  km2: number;
  ft2: number;
  /** Kenyan cadastral/agricultural convenience units. */
  roods: number;
  guntas: number;
}

/** WGS 84 ellipsoid parameters. */
export interface Ellipsoid {
  a: number;
  f: number;
  b: number;
  e2: number;
  /** Authalic (area-equivalent) sphere radius in metres. */
  authalicRadius: number;
}

/* ------------------------------------------------------------------------- */
/* geodesy.ts                                                                 */
/* ------------------------------------------------------------------------- */

/** WGS 84 ellipsoid constants. */
export declare const WGS84: Ellipsoid;

/** Parse a DMS or decimal-degree string. Accepts `1°23'45.6"S`, `1 23 45.6 S`,
 *  `-1.396`, `36°49'18.8"E`, and hemisphere suffixes N/S/E/W. `null` if invalid. */
export declare function parseDMS(input: string): number | null;

/**
 * Format decimal degrees as DMS, e.g. `1°23′45.6″S`.
 * `axis` disambiguates the hemisphere tag: 'auto' (default) treats |deg| ≤ 90
 * as a latitude and anything larger as a longitude; pass 'lon' explicitly for
 * longitudes such as 36.8219 → `36°49′18.8″E`.
 */
export declare function formatDMS(deg: number, decimals?: number, axis?: 'auto' | 'lat' | 'lon'): string;

/** Format decimal degrees with fixed decimals and a hemisphere tag (`axis` as above). */
export declare function formatDD(deg: number, decimals?: number, axis?: 'auto' | 'lat' | 'lon'): string;

/** Inverse geodesic problem on WGS 84. */
export declare function geodesicInverse(
  a: LatLon,
  b: LatLon,
): { distance: number; azi1: number; azi2: number };

/** Direct geodesic problem: point reached from `start` on `azimuth` after `distance` metres. */
export declare function geodesicDirect(start: LatLon, azimuth: number, distance: number): LatLon;

/** Sample a geodesic line between two points: `maxSamples` cap, `intervalM` spacing floor. */
export declare function geodesicPath(
  a: LatLon,
  b: LatLon,
  maxSamples?: number,
  intervalM?: number,
): LatLon[];

/** Sample a multi-vertex geodesic polyline, preserving vertices, at a spacing. */
export declare function geodesicPolylinePath(
  points: LatLon[],
  maxSamples?: number,
  intervalM?: number,
): { points: LatLon[]; cumulative: number[]; totalDistance: number };

/** Geodesic polygon area and perimeter on the WGS 84 ellipsoid (Karney). */
export declare function geodesicPolygonArea(points: LatLon[]): { area: number; perimeter: number };

/* ------------------------------------------------------------------------- */
/* shoelace.ts                                                                */
/* ------------------------------------------------------------------------- */

/** Signed planar area (m²) via the Gaussian trapezoid (shoelace) formula. */
export declare function signedArea(points: XYPoint[]): number;

/** Absolute planar area (m²) — the verified Gaussian shoelace result. */
export declare function shoelaceArea(points: XYPoint[]): number;

/** Closed-ring planar perimeter (m). */
export declare function perimeter2D(points: XYPoint[]): number;

/** Polygon area centroid for a closed ring. */
export declare function centroid2D(points: XYPoint[]): XYPoint;

/* ------------------------------------------------------------------------- */
/* polygon area (v2 API lives in `./polygon-types.ts`)                        */
/* ------------------------------------------------------------------------- */

/* The v1 `AreaResult` / `computePolygonArea` surface was replaced by
   `computePolygon` in `./polygon-types.ts` (three reference systems: local
   X/Y, UTM, geographic; three surfaces: grid, geodesic, ground). */

/** Convert a square-metre magnitude into the full unit set. */
export declare function toAreaUnits(m2: number): AreaUnits;

/* ------------------------------------------------------------------------- */
/* units.ts — land area & unit converter                                      */
/* ------------------------------------------------------------------------- */

export type UnitGroup = 'metric' | 'imperial' | 'cadastral' | 'agricultural';

export interface AreaUnitDef {
  id: string;
  label: string;
  symbol: string;
  /** Multiplier: value_in_unit × factor = square metres. */
  factor: number;
  group: UnitGroup;
  /** Human note shown in the converter (e.g. Kenyan usage). */
  note?: string;
}

/** Every supported land-area unit. */
export declare const AREA_UNITS: AreaUnitDef[];

export interface ConversionRow {
  unit: string;
  label: string;
  symbol: string;
  value: number;
  group: UnitGroup;
}

/** Convert `value` from one unit id to another. */
export declare function convertArea(value: number, from: string, to: string): number;

/** Convert into every supported unit, ordered by magnitude. */
export declare function convertAll(value: number, from: string): ConversionRow[];

/** Land-parcel equality helper used by the converter's comparison panel. */
export declare function areaFromDimensions(width: number, length: number, unit: 'm' | 'ft'): number;

/* ------------------------------------------------------------------------- */
/* terrain.ts                                                                 */
/* ------------------------------------------------------------------------- */

export interface TerrainSample {
  /** Cumulative horizontal distance along the profile, metres. */
  distance: number;
  /** Elevation, metres above mean sea level. */
  elevation: number;
  lat?: number;
  lon?: number;
}

export type TerrainCategory = 'Flat' | 'Gentle' | 'Rolling' | 'Hilly' | 'Steep';

export interface SlopeSegment {
  index: number;
  from: number;
  to: number;
  run: number;
  rise: number;
  /** Percent grade (rise/run × 100). */
  slopePct: number;
  slopeDeg: number;
}

export interface TerrainResult {
  samples: TerrainSample[];
  distance: number;
  gain: number;
  descent: number;
  net: number;
  min: number;
  max: number;
  range: number;
  startElevation: number;
  endElevation: number;
  avgSlopePct: number;
  maxSlopePct: number;
  maxSlopeDeg: number;
  maxSlopeAt: number;
  category: TerrainCategory;
  segments: SlopeSegment[];
  meanElevation: number;
}

export interface TerrainOptions {
  /** Moving-average window in samples; 0/undefined disables smoothing. */
  smoothingWindow?: number;
  /** Treat elevations below this as no-data and interpolate them. */
  noDataBelow?: number;
}

/** Ordered bounds of the slope-percent classification. Exported so UI copy and
 *  maths can never disagree. */
export declare const TERRAIN_THRESHOLDS: {
  flat: number;
  gentle: number;
  rolling: number;
  hilly: number;
};

export declare function classifySlope(maxSlopePct: number): TerrainCategory;

/** Core profile statistics: gain, descent, distance, grades, category. */
export declare function computeTerrainProfile(
  samples: TerrainSample[],
  options?: TerrainOptions,
): TerrainResult;

/* ------------------------------------------------------------------------- */
/* parse.ts — client-side tabular ingestion                                   */
/* ------------------------------------------------------------------------- */

export interface TabularData {
  headers: string[];
  rows: Array<Record<string, string | number>>;
  delimiter: string;
}

/** RFC 4180 tolerant CSV/TSV parser (quotes, CRLF, BOM). */
export declare function parseDelimitedText(text: string, delimiter?: string): TabularData;

/** Parse an .xlsx/.xls workbook's first sheet into the same shape (dynamic import of `xlsx`). */
export declare function parseSpreadsheet(buffer: ArrayBuffer): Promise<TabularData>;

export type TerrainColumnRole =
  | 'distance'
  | 'elevation'
  | 'lat'
  | 'lon'
  | 'chainage'
  | 'unknown';

export interface TerrainColumnMap {
  distance: string | null;
  elevation: string | null;
  lat: string | null;
  lon: string | null;
}

/** Heuristically map arbitrary headers onto terrain roles. */
export declare function detectTerrainColumns(headers: string[]): TerrainColumnMap;

export interface TerrainIngestResult {
  samples: TerrainSample[];
  mapping: TerrainColumnMap;
  source: 'distance+elevation' | 'lat/lon+elevation';
  warnings: string[];
  /** Coordinates in input order, for drawing the profile trace on a map. */
  trace: LatLon[];
}

/** Convert tabular rows into an elevation profile, geodesically accumulating
 *  distance when lat/lon columns are present. */
export declare function ingestTerrainRows(data: TabularData): TerrainIngestResult;

/** Convenience: sample an elevation profile along a geodesic line given an
 *  elevation provider (already-fetched elevations, in order). */
export declare function buildProfileFromPath(
  points: LatLon[],
  elevations: number[],
): TerrainSample[];

/* ------------------------------------------------------------------------- */
/* format.ts — display formatting shared by UI and exports                    */
/* ------------------------------------------------------------------------- */

export declare function fmtNumber(value: number, decimals?: number): string;
export declare function fmtArea(m2: number, unit?: string): string;
export declare function fmtLength(m: number, unit?: LengthUnit): string;
export declare function fmtSigned(value: number, decimals?: number): string;
