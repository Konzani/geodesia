/**
 * GEODESIA — POLYGON AREA CONTRACT (v2)
 * ---------------------------------------------------------------------------
 * Restores the legacy "polygon area calculator" methodology, with three input
 * reference systems and three measured surfaces:
 *
 *   Local X/Y   → grid surface only (planar, no geographic reference)
 *   UTM (E,N)   → grid surface + geodesic surface + ground (CSF) surface
 *   Lat/Lon     → auto-project to UTM for the grid surface, plus geodesic and
 *                 ground surfaces
 *
 * Accuracy notes that the implementation must honour:
 *  - Grid area/perimeter: Gaussian shoelace / planar distance on projected
 *    coordinates, with the ring translated to its first vertex before the cross
 *    products accumulate (keeps double precision on large eastings).
 *  - Geodesic area/perimeter: Karney's ellipsoidal algorithms on WGS 84
 *    (GeographicLib), never a sphere approximation.
 *  - UTM: WGS 84 transverse Mercator, zone 1–60, hemisphere, false easting
 *    500 000 m, false northing 10 000 000 m (south), k0 = 0.9996, computed by a
 *    self-contained Krüger order-6 series implementation so grid results match a
 *    projection library to sub-millimetre level rather than approximating it.
 *  - Ground surface: combined scale factor CSF = k · EF where
 *    k = k0 · (1 + x² / (2R²)),  x = meanE − falseEasting,
 *    R = √(M·N) at the centroid latitude,  EF = a / (a + h);
 *    groundPerimeter = gridPerimeter / CSF, groundArea = gridArea / CSF².
 *  - Validation: ≥3 vertices, no consecutive duplicates, non-zero area, and
 *    self-intersecting rings are detected and reported (not silently repaired).
 */

import type { AreaUnits, LatLon, XYPoint } from './types';

/* ------------------------------------------------------------------ types */

export type PolygonMode = 'xy' | 'utm' | 'latlon';

export type Hemisphere = 'N' | 'S';

/** Projected (grid) coordinate in metres. */
export interface UtmPoint {
  E: number;
  N: number;
}

export interface UtmParams {
  /** UTM zone 1–60. */
  zone: number;
  hemisphere: Hemisphere;
}

/** One vertex, expressed as entered, on the grid, and on the ellipsoid. */
export interface PolygonVertex {
  index: number;
  /** Coordinates exactly as supplied by the user (X,Y · E,N · lon,lat). */
  input: { x: number; y: number };
  /** Projected grid coordinates in metres (UTM, or the raw X/Y pair). */
  grid: UtmPoint | null;
  /** Geographic coordinates on WGS 84; null for local X/Y input. */
  geo: LatLon | null;
}

/** One boundary side (the ring closes: leg n runs from the last vertex to the first). */
export interface PolygonLeg {
  index: number;
  from: number;
  to: number;
  gridDistance: number | null;
  geodesicDistance: number | null;
  groundDistance: number | null;
  /** Grid bearing, clockwise from grid north, degrees 0–360. */
  gridBearing: number | null;
  /** Forward azimuth on WGS 84, degrees 0–360. */
  geodesicAzimuth: number | null;
}

export interface SurfaceMetrics {
  area: number;
  perimeter: number;
}

export interface PolygonOptions {
  /** Compute the geodesic surface (default: true when a geographic reference exists). */
  geodesic?: boolean;
  /** Compute the ground surface (default: false; requires a geographic reference). */
  ground?: boolean;
  /** Mean ground elevation in metres used by the elevation factor (default 0). */
  meanElevationM?: number;
  /** User-supplied combined scale factor; overrides the projected estimate. */
  combinedScaleFactor?: number;
}

export interface PolyCentroid {
  grid: UtmPoint | null;
  geo: LatLon | null;
}

export interface PolygonResult {
  mode: PolygonMode;
  vertexCount: number;
  /** UTM zone actually used (user supplied, or derived from the centroid). */
  zone: number | null;
  hemisphere: Hemisphere | null;
  /** Whether the zone/hemisphere were derived automatically from the centroid. */
  zoneAuto: boolean;
  grid: SurfaceMetrics;
  geodesic: SurfaceMetrics | null;
  ground: SurfaceMetrics | null;
  /** Combined scale factor applied to the ground surface. */
  csf: number | null;
  /** Projection scale factor k at the centroid (null for local X/Y). */
  projectScaleFactor: number | null;
  /** Elevation factor a / (a + h). */
  elevationFactor: number | null;
  units: AreaUnits;
  vertices: PolygonVertex[];
  legs: PolygonLeg[];
  centroid: PolyCentroid;
  closure: number;
  selfIntersecting: boolean;
  warnings: string[];
}

export interface PolygonValidation {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

/** Input union: exactly one reference system per calculation. */
export type PolygonInput =
  | { mode: 'xy'; points: XYPoint[] }
  | { mode: 'utm'; points: UtmPoint[]; zone: number; hemisphere: Hemisphere }
  | { mode: 'latlon'; points: LatLon[]; zone?: number; hemisphere?: Hemisphere };

/* ---------------------------------------------------------------- functions */

/**
 * Full polygon evaluation. Asynchronous by contract (projection work is
 * prepared before the ring is measured), resolving as soon as the inputs are
 * validated — the UTM engine itself is a synchronous, dependency-free series.
 *
 * Throws `Error` with an actionable message for unusable input (fewer than three
 * vertices, duplicate consecutive vertices, zero/invalid area, invalid zone,
 * out-of-range coordinates). Self-intersection is reported on the result
 * (`selfIntersecting: true`) rather than thrown, because the ring is still
 * measurable and the user needs to see the diagnosis.
 */
export declare function computePolygon(
  input: PolygonInput,
  options?: PolygonOptions,
): Promise<PolygonResult>;

/** Pre-flight validation used by the UI before running the full evaluation. */
export declare function validatePolygonInput(input: PolygonInput): PolygonValidation;

/** UTM zone + hemisphere for a geographic position (zone from longitude, hemisphere from latitude). */
export declare function utmZoneFromLonLat(lon: number, lat: number): UtmParams;

/** Build the human-readable UTM reference for a zone/hemisphere (e.g. `WGS 84 / UTM zone 37S (EPSG:32737)`). */
export declare function utmDefinition(zone: number, hemisphere: Hemisphere): string;

/** Forward projection WGS 84 → UTM. */
export declare function lonLatToUtm(point: LatLon, params: UtmParams): UtmPoint;

/** Inverse projection UTM → WGS 84. */
export declare function utmToLonLat(point: UtmPoint, params: UtmParams): LatLon;

/**
 * Combined scale factor estimate for a parcel.
 * `projectScaleFactor` uses the legacy published formula above; `elevationFactor`
 * is a/(a+h). Supply `override` to use a surveyed CSF instead.
 */
export declare function estimateCombinedScaleFactor(args: {
  points: UtmPoint[];
  centroid: LatLon;
  meanElevationM?: number;
  zone: number;
  override?: number | null;
}): { csf: number; projectScaleFactor: number; elevationFactor: number };

/** Signed-area self-intersection test (O(n²), rings up to 500 vertices). */
export declare function ringSelfIntersects(points: Array<{ x: number; y: number }>): boolean;

/** Format a UTM easting/northing pair with survey-appropriate precision. */
export declare function formatUtm(point: UtmPoint): { E: string; N: string };

/** Ellipsoid constants used by the CSF estimate (WGS 84 + UTM k0). */
export declare const UTM_CONSTANTS: {
  a: number;
  e2: number;
  k0: number;
  falseEasting: number;
  falseNorthingSouth: number;
};
