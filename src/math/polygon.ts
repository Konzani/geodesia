/**
 * Geodesia — polygon area engine (v2: grid · geodesic · ground)
 * ---------------------------------------------------------------------------
 * Restores the legacy polygon-area methodology on top of the built-in UTM
 * projection engine (order-6 Krüger series, no external dependency):
 *
 *   X/Y    → grid surface only (raw planar metres)
 *   UTM    → grid surface from E/N, plus geodesic and ground surfaces
 *   Lat/Lon → auto-zone UTM grid surface, plus geodesic and ground surfaces
 *
 * Grid area is the Gaussian shoelace of the projected ring (translated to the
 * first vertex for precision); the geodesic surface is Karney's ellipsoidal
 * area/perimeter; the ground surface divides grid metrics by the combined scale
 * factor (CSF = k · EF, k = k0(1 + x²/2R²), EF = a/(a+h)).
 *
 * Self-intersecting rings are measured and reported (`selfIntersecting: true`),
 * not thrown: a zero signed area is only rejected when the ring is simple.
 */
import type {
  Hemisphere,
  PolyCentroid,
  PolygonInput,
  PolygonLeg,
  PolygonMode,
  PolygonOptions,
  PolygonResult,
  PolygonValidation,
  PolygonVertex,
  SurfaceMetrics,
  UtmParams,
  UtmPoint,
} from './polygon-types';
import type { LatLon, XYPoint } from './types';
import { geodesicInverse, geodesicPolygonArea } from './geodesy';
import { centroid2D, perimeter2D, shoelaceArea } from './shoelace';
import { toAreaUnits } from './units';
import {
  UTM_CONSTANTS,
  loadUtmEngine,
  lonLatToUtm,
  utmDefinition,
  utmToLonLat,
  utmZoneFromLonLat,
} from './utm';

const DEGREES_TO_RADIANS = Math.PI / 180;
/** Native-unit tolerance for duplicate vertices (metres or degrees). */
const DUPLICATE_TOLERANCE = 1e-9;

interface CoordinatePair {
  x: number;
  y: number;
}

/* ------------------------------------------------------------------------- */
/* Small helpers                                                             */
/* ------------------------------------------------------------------------- */

function normalizeBearing(degrees: number): number {
  const wrapped = degrees % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

function planarDistance(a: UtmPoint, b: UtmPoint): number {
  return Math.hypot(b.E - a.E, b.N - a.N);
}

function meanLatLon(points: LatLon[]): LatLon {
  let lat = 0;
  let lon = 0;
  for (const point of points) {
    lat += point.lat;
    lon += point.lon;
  }
  return { lat: lat / points.length, lon: lon / points.length };
}

/** Strip an explicit closing duplicate; report whether the ring was closed. */
function stripClosingDuplicate(
  points: Array<{ x: number; y: number }>,
  tolerance = DUPLICATE_TOLERANCE,
): { ring: Array<{ x: number; y: number }>; explicitClosure: boolean } {
  if (points.length < 2) return { ring: points, explicitClosure: false };
  const first = points[0];
  const last = points[points.length - 1];
  if (Math.abs(first.x - last.x) <= tolerance && Math.abs(first.y - last.y) <= tolerance) {
    return { ring: points.slice(0, -1), explicitClosure: true };
  }
  return { ring: points, explicitClosure: false };
}

function pushWarningOnce(warnings: string[], message: string): void {
  if (!warnings.includes(message)) warnings.push(message);
}

/** Planar polygon centroid, falling back to the vertex mean for degenerate rings. */
function planarCentroid(points: XYPoint[]): UtmPoint {
  try {
    const centroid = centroid2D(points);
    return { E: centroid.x, N: centroid.y };
  } catch {
    let E = 0;
    let N = 0;
    for (const point of points) {
      E += point.x;
      N += point.y;
    }
    return { E: E / points.length, N: N / points.length };
  }
}

/* ------------------------------------------------------------------------- */
/* Self-intersection                                                         */
/* ------------------------------------------------------------------------- */

function orientation(a: CoordinatePair, b: CoordinatePair, c: CoordinatePair): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function onSegment(a: CoordinatePair, b: CoordinatePair, c: CoordinatePair, tolerance = 1e-9): boolean {
  return (
    Math.min(a.x, b.x) - tolerance <= c.x &&
    c.x <= Math.max(a.x, b.x) + tolerance &&
    Math.min(a.y, b.y) - tolerance <= c.y &&
    c.y <= Math.max(a.y, b.y) + tolerance
  );
}

function segmentsIntersect(
  a: CoordinatePair,
  b: CoordinatePair,
  c: CoordinatePair,
  d: CoordinatePair,
): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);

  const s1 = Math.abs(o1) <= 1e-9 ? 0 : Math.sign(o1);
  const s2 = Math.abs(o2) <= 1e-9 ? 0 : Math.sign(o2);
  const s3 = Math.abs(o3) <= 1e-9 ? 0 : Math.sign(o3);
  const s4 = Math.abs(o4) <= 1e-9 ? 0 : Math.sign(o4);

  if (s1 !== s2 && s3 !== s4) return true;
  if (s1 === 0 && onSegment(a, b, c)) return true;
  if (s2 === 0 && onSegment(a, b, d)) return true;
  if (s3 === 0 && onSegment(c, d, a)) return true;
  if (s4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** Signed-area self-intersection test (O(n²), rings up to 500 vertices). */
export function ringSelfIntersects(points: Array<{ x: number; y: number }>): boolean {
  if (!Array.isArray(points) || points.length < 4) return false;
  const count = points.length;
  for (let i = 0; i < count; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % count];
    for (let j = i + 1; j < count; j += 1) {
      // Skip edges that share a vertex (adjacent sides, including the closing pair).
      if (j === i + 1 || (i === 0 && j === count - 1)) continue;
      const c = points[j];
      const d = points[(j + 1) % count];
      if (segmentsIntersect(a, b, c, d)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------------- */
/* Combined scale factor                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Combined scale factor estimate for a parcel.
 * `projectScaleFactor` uses the legacy published formula k = k0(1 + x²/2R²)
 * with x = meanE − 500 000 and R = √(M·N) at the centroid latitude;
 * `elevationFactor` is a/(a+h). Supply `override` to use a surveyed CSF instead.
 */
export function estimateCombinedScaleFactor(args: {
  points: UtmPoint[];
  centroid: LatLon;
  meanElevationM?: number;
  zone: number;
  override?: number | null;
}): { csf: number; projectScaleFactor: number; elevationFactor: number } {
  if (!args || typeof args !== 'object') {
    throw new Error('estimateCombinedScaleFactor expects { points, centroid, zone }.');
  }
  if (!Array.isArray(args.points) || args.points.length === 0) {
    throw new Error('At least one grid point is required to estimate the combined scale factor.');
  }
  for (const [index, point] of args.points.entries()) {
    if (!point || typeof point.E !== 'number' || typeof point.N !== 'number' || !Number.isFinite(point.E) || !Number.isFinite(point.N)) {
      throw new Error(`Grid point ${index + 1} is not a finite { E, N } pair.`);
    }
  }
  const centroid = args.centroid;
  if (!centroid || typeof centroid.lat !== 'number' || typeof centroid.lon !== 'number' || !Number.isFinite(centroid.lat) || !Number.isFinite(centroid.lon) || centroid.lat < -90 || centroid.lat > 90) {
    throw new Error('A valid centroid latitude/longitude is required to estimate the combined scale factor.');
  }
  if (typeof args.zone !== 'number' || !Number.isInteger(args.zone) || args.zone < 1 || args.zone > 60) {
    throw new Error(`UTM zone must be an integer between 1 and 60 (received ${String(args.zone)}).`);
  }

  const meanElevationM = args.meanElevationM ?? 0;
  if (typeof meanElevationM !== 'number' || !Number.isFinite(meanElevationM)) {
    throw new Error('meanElevationM must be a finite number of metres.');
  }
  if (UTM_CONSTANTS.a + meanElevationM <= 0) {
    throw new Error('meanElevationM is below the ellipsoid; the elevation factor is undefined.');
  }
  let override: number | null = null;
  if (args.override !== undefined && args.override !== null) {
    if (typeof args.override !== 'number' || !Number.isFinite(args.override) || args.override <= 0) {
      throw new Error('combinedScaleFactor override must be a finite number greater than 0.');
    }
    override = args.override;
  }

  const phi = centroid.lat * DEGREES_TO_RADIANS;
  const sinPhi = Math.sin(phi);
  const w = Math.sqrt(1 - UTM_CONSTANTS.e2 * sinPhi * sinPhi);
  const primeVertical = UTM_CONSTANTS.a / w;
  const meridional = (UTM_CONSTANTS.a * (1 - UTM_CONSTANTS.e2)) / (w * w * w);
  const radius = Math.sqrt(primeVertical * meridional);

  let eastingSum = 0;
  for (const point of args.points) eastingSum += point.E;
  const meanEasting = eastingSum / args.points.length;
  const x = meanEasting - UTM_CONSTANTS.falseEasting;

  const projectScaleFactor = UTM_CONSTANTS.k0 * (1 + (x * x) / (2 * radius * radius));
  const elevationFactor = UTM_CONSTANTS.a / (UTM_CONSTANTS.a + meanElevationM);
  const csf = override ?? projectScaleFactor * elevationFactor;

  return { csf, projectScaleFactor, elevationFactor };
}

/* ------------------------------------------------------------------------- */
/* Validation                                                                */
/* ------------------------------------------------------------------------- */

function validateProvidedZone(zone: unknown, hemisphere: unknown, errors: string[]): void {
  if (zone !== undefined) {
    if (typeof zone !== 'number' || !Number.isInteger(zone) || zone < 1 || zone > 60) {
      errors.push(`UTM zone must be an integer between 1 and 60 (received ${String(zone)}).`);
    }
  }
  if (hemisphere !== undefined) {
    if (hemisphere !== 'N' && hemisphere !== 'S') {
      errors.push(`UTM hemisphere must be 'N' or 'S' (received ${String(hemisphere)}).`);
    }
  }
}

/** Pre-flight validation used by the UI before running the full evaluation. */
export function validatePolygonInput(input: PolygonInput): PolygonValidation {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Polygon input must be an object with a mode and points array.'], warnings };
  }
  const mode = input.mode;
  if (mode !== 'xy' && mode !== 'utm' && mode !== 'latlon') {
    return { ok: false, errors: ['Polygon mode must be "xy", "utm" or "latlon".'], warnings };
  }
  if (!Array.isArray(input.points)) {
    return { ok: false, errors: ['Points must be an array of vertices.'], warnings };
  }
  if (input.points.length < 3) {
    return {
      ok: false,
      errors: [`A polygon needs at least 3 vertices (received ${input.points.length}).`],
      warnings,
    };
  }

  const pairs: CoordinatePair[] = [];
  if (mode === 'xy') {
    input.points.forEach((point, index) => {
      if (!point || typeof point !== 'object') {
        errors.push(`Vertex ${index + 1} must be an { x, y } object.`);
        return;
      }
      const { x, y } = point as XYPoint;
      if (typeof x !== 'number' || !Number.isFinite(x) || typeof y !== 'number' || !Number.isFinite(y)) {
        errors.push(`Vertex ${index + 1} has a non-finite coordinate.`);
        return;
      }
      pairs.push({ x, y });
    });
  } else if (mode === 'utm') {
    validateProvidedZone(input.zone, input.hemisphere, errors);
    if (input.zone === undefined || input.hemisphere === undefined) {
      errors.push('UTM mode requires both a zone (1–60) and a hemisphere (N or S).');
    }
    input.points.forEach((point, index) => {
      if (!point || typeof point !== 'object') {
        errors.push(`Vertex ${index + 1} must be an { E, N } object.`);
        return;
      }
      const { E, N } = point as UtmPoint;
      if (typeof E !== 'number' || !Number.isFinite(E) || typeof N !== 'number' || !Number.isFinite(N)) {
        errors.push(`Vertex ${index + 1} has a non-finite UTM coordinate.`);
        return;
      }
      if (E < 0 || E > 1000000) {
        errors.push(`Vertex ${index + 1} easting ${E} is outside the plausible UTM range (0–1 000 000 m).`);
        return;
      }
      if (N < 0 || N > 10000000) {
        errors.push(`Vertex ${index + 1} northing ${N} is outside the plausible UTM range (0–10 000 000 m).`);
        return;
      }
      pairs.push({ x: E, y: N });
    });
  } else {
    validateProvidedZone(input.zone, input.hemisphere, errors);
    let invalidLatitude = false;
    let invalidLongitude = false;
    let likelySwappedStrong = true;
    let someLatitudeBeyond90 = false;
    let allFirstWithin20 = true;
    let allSecondBetween20And60 = true;
    input.points.forEach((point, index) => {
      if (!point || typeof point !== 'object') {
        errors.push(`Vertex ${index + 1} must be a { lat, lon } object.`);
        return;
      }
      const { lat, lon } = point as LatLon;
      if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
        invalidLatitude = true;
        if (typeof lat === 'number' && Number.isFinite(lat) && Math.abs(lat) > 90) someLatitudeBeyond90 = true;
      }
      if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
        invalidLongitude = true;
      }
      if (!(Math.abs(lon) <= 90 && Math.abs(lat) <= 180)) likelySwappedStrong = false;
      if (!(Math.abs(lon) <= 20)) allFirstWithin20 = false;
      if (!(Math.abs(lat) >= 20 && Math.abs(lat) <= 60)) allSecondBetween20And60 = false;
      pairs.push({ x: lon, y: lat });
    });
    if (invalidLatitude) {
      errors.push('Latitude values must be finite and between -90 and 90 degrees.');
    }
    if (invalidLongitude) {
      errors.push('Longitude values must be finite and between -180 and 180 degrees.');
    }
    if (invalidLatitude || invalidLongitude) {
      if (likelySwappedStrong && someLatitudeBeyond90) {
        warnings.push(
          'Coordinates look like Lat,Lon rather than Lon,Lat (the second column exceeds 90°). Swap the columns and try again.',
        );
      }
    } else if (allFirstWithin20 && allSecondBetween20And60) {
      warnings.push(
        'Coordinates look like Lat,Lon rather than Lon,Lat; the grid result may be displaced if the columns are swapped.',
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors, warnings };

  const stripped = stripClosingDuplicate(pairs);
  const ring = stripped.ring;
  if (ring.length < 3) {
    errors.push('A polygon needs at least 3 distinct vertices (remove the repeated closing vertex).');
    return { ok: false, errors, warnings };
  }
  for (let i = 1; i < ring.length; i += 1) {
    if (Math.abs(ring[i].x - ring[i - 1].x) <= DUPLICATE_TOLERANCE && Math.abs(ring[i].y - ring[i - 1].y) <= DUPLICATE_TOLERANCE) {
      errors.push(`Duplicate consecutive vertices at positions ${i} and ${i + 1}. Remove repeated vertices.`);
      break;
    }
  }
  if (errors.length > 0) return { ok: false, errors, warnings };

  const selfIntersecting = ringSelfIntersects(ring);
  if (selfIntersecting) {
    warnings.push('The polygon boundary self-intersects (crossing edges); the reported area may be ambiguous.');
  } else {
    const signed = shoelaceArea(ring);
    if (!(signed > 0)) {
      errors.push('Polygon area is zero/invalid. Check vertex order and duplicate/collinear points.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/* ------------------------------------------------------------------------- */
/* Result assembly                                                           */
/* ------------------------------------------------------------------------- */

interface NormalisedOptions {
  geodesic: boolean;
  ground: boolean;
  meanElevationM: number;
  combinedScaleFactor: number | null;
}

interface AssembleArgs {
  mode: PolygonMode;
  inputPairs: CoordinatePair[];
  grid: UtmPoint[];
  geo: LatLon[] | null;
  centroidGeo: LatLon | null;
  zone: number | null;
  hemisphere: Hemisphere | null;
  zoneAuto: boolean;
  closure: number;
  options: NormalisedOptions;
  warnings: string[];
}

function assemblePolygon(args: AssembleArgs): PolygonResult {
  const warnings = args.warnings;
  const gridXY: XYPoint[] = args.grid.map((point) => ({ x: point.E, y: point.N }));
  const gridArea = shoelaceArea(gridXY);
  const gridPerimeter = perimeter2D(gridXY);
  const centroidGrid = planarCentroid(gridXY);
  const hasGeo = args.geo !== null && args.geo.length === args.grid.length;

  let geodesicSurface: SurfaceMetrics | null = null;
  let groundSurface: SurfaceMetrics | null = null;
  let csf: number | null = null;
  let projectScaleFactor: number | null = null;
  let elevationFactor: number | null = null;

  if (hasGeo && args.options.geodesic) {
    geodesicSurface = geodesicPolygonArea(args.geo as LatLon[]);
  }
  if (!hasGeo && args.options.geodesic) {
    pushWarningOnce(warnings, 'Geodesic surface needs a geographic reference; unavailable for local X/Y input.');
  }

  if (hasGeo && args.zone !== null && args.centroidGeo !== null) {
    const estimate = estimateCombinedScaleFactor({
      points: args.grid,
      centroid: args.centroidGeo,
      meanElevationM: args.options.meanElevationM,
      zone: args.zone,
      override: args.options.combinedScaleFactor,
    });
    projectScaleFactor = estimate.projectScaleFactor;
    elevationFactor = estimate.elevationFactor;
    if (args.options.ground) {
      csf = estimate.csf;
      groundSurface = {
        area: gridArea / (csf * csf),
        perimeter: gridPerimeter / csf,
      };
    }
  }
  if (!hasGeo && args.options.ground) {
    pushWarningOnce(warnings, 'Ground (CSF) surface needs a geographic reference; unavailable for local X/Y input.');
  }

  const geodesicPoints = hasGeo ? (args.geo as LatLon[]) : null;
  const legs: PolygonLeg[] = args.grid.map((from, index) => {
    const to = (index + 1) % args.grid.length;
    const deltaE = args.grid[to].E - from.E;
    const deltaN = args.grid[to].N - from.N;
    const gridDistance = Math.hypot(deltaE, deltaN);
    const gridBearing = normalizeBearing((Math.atan2(deltaE, deltaN) * 180) / Math.PI);
    let geodesicDistance: number | null = null;
    let geodesicAzimuth: number | null = null;
    if (geodesicPoints !== null) {
      const inverse = geodesicInverse(geodesicPoints[index], geodesicPoints[to]);
      geodesicDistance = inverse.distance;
      geodesicAzimuth = inverse.azi1;
    }
    return {
      index,
      from: index,
      to,
      gridDistance,
      geodesicDistance,
      groundDistance: csf === null ? null : gridDistance / csf,
      gridBearing,
      geodesicAzimuth,
    };
  });

  const vertices: PolygonVertex[] = args.grid.map((gridPoint, index) => ({
    index,
    input: args.inputPairs[index],
    grid: gridPoint,
    geo: geodesicPoints === null ? null : geodesicPoints[index],
  }));

  const selfIntersecting = ringSelfIntersects(ringXY(args.grid));
  if (selfIntersecting) {
    pushWarningOnce(warnings, 'The polygon boundary self-intersects (crossing edges); the reported area may be ambiguous.');
  }

  const centroid: PolyCentroid = { grid: centroidGrid, geo: args.centroidGeo };

  return {
    mode: args.mode,
    vertexCount: args.grid.length,
    zone: args.zone,
    hemisphere: args.hemisphere,
    zoneAuto: args.zoneAuto,
    grid: { area: gridArea, perimeter: gridPerimeter },
    geodesic: geodesicSurface,
    ground: groundSurface,
    csf,
    projectScaleFactor,
    elevationFactor,
    units: toAreaUnits(gridArea),
    vertices,
    legs,
    centroid,
    closure: args.closure,
    selfIntersecting,
    warnings,
  };
}

function ringXY(grid: UtmPoint[]): XYPoint[] {
  return grid.map((point) => ({ x: point.E, y: point.N }));
}

/* ------------------------------------------------------------------------- */
/* Options                                                                   */
/* ------------------------------------------------------------------------- */

function readOptions(options: PolygonOptions): {
  geodesic: boolean | undefined;
  ground: boolean | undefined;
  meanElevationM: number;
  combinedScaleFactor: number | null;
} {
  if (options === undefined || options === null) {
    return { geodesic: undefined, ground: undefined, meanElevationM: 0, combinedScaleFactor: null };
  }
  if (typeof options !== 'object') {
    throw new Error('Polygon options must be an object.');
  }
  const geodesic = options.geodesic;
  if (geodesic !== undefined && typeof geodesic !== 'boolean') {
    throw new Error('options.geodesic must be a boolean.');
  }
  const ground = options.ground;
  if (ground !== undefined && typeof ground !== 'boolean') {
    throw new Error('options.ground must be a boolean.');
  }
  const meanElevationM = options.meanElevationM ?? 0;
  if (typeof meanElevationM !== 'number' || !Number.isFinite(meanElevationM)) {
    throw new Error('options.meanElevationM must be a finite number of metres.');
  }
  let combinedScaleFactor: number | null = null;
  if (options.combinedScaleFactor !== undefined) {
    const csf = options.combinedScaleFactor;
    if (typeof csf !== 'number' || !Number.isFinite(csf) || csf <= 0) {
      throw new Error('options.combinedScaleFactor must be a finite number greater than 0.');
    }
    combinedScaleFactor = csf;
  }
  return { geodesic, ground, meanElevationM, combinedScaleFactor };
}

/* ------------------------------------------------------------------------- */
/* computePolygon                                                            */
/* ------------------------------------------------------------------------- */

/**
 * Full polygon evaluation. Always returns a Promise (as the contract requires);
 * the UTM engine is built into the math module, so no chunk loading happens.
 */
export async function computePolygon(
  input: PolygonInput,
  options: PolygonOptions = {},
): Promise<PolygonResult> {
  const validation = validatePolygonInput(input);
  if (!validation.ok) {
    throw new Error(validation.errors.join(' '));
  }
  const warnings = [...validation.warnings];
  const optionState = readOptions(options);

  if (input.mode === 'xy') {
    const rawPairs: CoordinatePair[] = input.points.map((point) => ({ x: point.x, y: point.y }));
    const stripped = stripClosingDuplicate(rawPairs);
    const ring = stripped.ring;
    const grid: UtmPoint[] = ring.map((pair) => ({ E: pair.x, N: pair.y }));
    const last = ring[ring.length - 1];
    const first = ring[0];
    const closure = stripped.explicitClosure ? 0 : Math.hypot(last.x - first.x, last.y - first.y);
    return assemblePolygon({
      mode: 'xy',
      inputPairs: ring,
      grid,
      geo: null,
      centroidGeo: null,
      zone: null,
      hemisphere: null,
      zoneAuto: false,
      closure,
      // Local X/Y has no geographic reference: only honour explicit requests.
      options: {
        geodesic: optionState.geodesic === true,
        ground: optionState.ground === true,
        meanElevationM: optionState.meanElevationM,
        combinedScaleFactor: null,
      },
      warnings,
    });
  }

  // The engine is built in; awaiting keeps the contract's async shape and stays
  // compatible with callers that previously awaited the lazy engine.
  await loadUtmEngine();

  if (input.mode === 'utm') {
    const params: UtmParams = { zone: input.zone, hemisphere: input.hemisphere };
    // Fail fast with a clear message if the zone/hemisphere pair is unusable.
    utmDefinition(params.zone, params.hemisphere);
    const rawPairs: CoordinatePair[] = input.points.map((point) => ({ x: point.E, y: point.N }));
    const stripped = stripClosingDuplicate(rawPairs);
    const ring = stripped.ring;
    const grid: UtmPoint[] = ring.map((pair) => ({ E: pair.x, N: pair.y }));
    const geo = grid.map((point) => utmToLonLat(point, params));
    const centroidGeo = meanLatLon(geo);
    const last = grid[grid.length - 1];
    const first = grid[0];
    const closure = stripped.explicitClosure ? 0 : planarDistance(last, first);
    return assemblePolygon({
      mode: 'utm',
      inputPairs: ring,
      grid,
      geo,
      centroidGeo,
      zone: params.zone,
      hemisphere: params.hemisphere,
      zoneAuto: false,
      closure,
      options: {
        geodesic: optionState.geodesic ?? true,
        ground: optionState.ground ?? false,
        meanElevationM: optionState.meanElevationM,
        combinedScaleFactor: optionState.combinedScaleFactor,
      },
      warnings,
    });
  }

  const rawPairs: CoordinatePair[] = input.points.map((point) => ({ x: point.lon, y: point.lat }));
  const stripped = stripClosingDuplicate(rawPairs);
  const ring = stripped.ring;
  const latLonRing: LatLon[] = ring.map((pair) => ({ lat: pair.y, lon: pair.x }));
  const centroidGeo = meanLatLon(latLonRing);
  const auto = utmZoneFromLonLat(centroidGeo.lon, centroidGeo.lat);
  const zoneProvided = input.zone !== undefined;
  const hemisphereProvided = input.hemisphere !== undefined;
  const zone = zoneProvided ? (input.zone as number) : auto.zone;
  const hemisphere = hemisphereProvided ? (input.hemisphere as Hemisphere) : auto.hemisphere;
  const zoneAuto = !zoneProvided || !hemisphereProvided;
  if (zoneProvided !== hemisphereProvided) {
    pushWarningOnce(
      warnings,
      'Zone and hemisphere should be supplied together; the missing value was derived from the centroid.',
    );
  }
  const params: UtmParams = { zone, hemisphere };
  const grid = latLonRing.map((point) => lonLatToUtm(point, params));
  const closure = stripped.explicitClosure
    ? 0
    : geodesicInverse(latLonRing[latLonRing.length - 1], latLonRing[0]).distance;

  return assemblePolygon({
    mode: 'latlon',
    inputPairs: ring,
    grid,
    geo: latLonRing,
    centroidGeo,
    zone,
    hemisphere,
    zoneAuto,
    closure,
    options: {
      geodesic: optionState.geodesic ?? true,
      ground: optionState.ground ?? false,
      meanElevationM: optionState.meanElevationM,
      combinedScaleFactor: optionState.combinedScaleFactor,
    },
    warnings,
  });
}
