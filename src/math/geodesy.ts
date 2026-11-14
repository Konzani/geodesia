/**
 * Geodesia — geodesy
 * ---------------------------------------------------------------------------
 * WGS 84 ellipsoid constants, DMS/DD parsing and formatting, and the
 * ellipsoidal geodesic problems (Karney 2013) via `geographiclib-geodesic`.
 *
 * The package ships a UMD/CJS build whose ESM namespace only exposes a
 * `default` export. The default export carries the `Geodesic` and
 * `PolygonArea` namespaces, so we take it as a default import and reach the
 * concrete `Geodesic.WGS84` instance and the `PolygonArea` constructor from it.
 * API verified empirically against geographiclib-geodesic 2.2.0:
 *   - `Geodesic.WGS84.Inverse(lat1, lon1, lat2, lon2)` -> { s12, azi1, azi2, ... }
 *   - `Geodesic.WGS84.Direct(lat1, lon1, azi1, s12)`  -> { lat2, lon2, azi2, ... }
 *   - `new PolygonArea.PolygonArea(Geodesic.WGS84, false).AddPoint(lat, lon)` then
 *     `.Compute(reverse, sign)` -> { number, perimeter, area }.
 *
 * Everything here is pure: no DOM, no network, no module-level mutable state.
 */
import geographiclib from 'geographiclib-geodesic';
import type { Ellipsoid, LatLon } from './types';

const GEOD = geographiclib.Geodesic.WGS84;
const PolygonAreaConstructor = geographiclib.PolygonArea.PolygonArea;

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_B = WGS84_A * (1 - WGS84_F);
const WGS84_E2 = WGS84_F * (2 - WGS84_F);

/** Authalic (area-equivalent) radius of the WGS 84 ellipsoid, metres.
 *  R_q = sqrt(A / 4π) with
 *  A = 2πa²(1 + (1 - e²)/e · atanh e). */
function authalicRadius(a: number, e2: number): number {
  const e = Math.sqrt(e2);
  const surfaceArea = 2 * Math.PI * a * a * (1 + ((1 - e2) / e) * Math.atanh(e));
  return Math.sqrt(surfaceArea / (4 * Math.PI));
}

/** WGS 84 ellipsoid constants. */
export const WGS84: Ellipsoid = {
  a: WGS84_A,
  f: WGS84_F,
  b: WGS84_B,
  e2: WGS84_E2,
  authalicRadius: authalicRadius(WGS84_A, WGS84_E2),
};

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                        */
/* ------------------------------------------------------------------------- */

function assertFiniteNumber(value: number, label: string): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

function assertLatLon(point: LatLon, label: string): void {
  if (!point || typeof point !== 'object') {
    throw new Error(`${label} must be a { lat, lon } object.`);
  }
  assertFiniteNumber(point.lat, `${label}.lat`);
  assertFiniteNumber(point.lon, `${label}.lon`);
  if (point.lat < -90 || point.lat > 90) {
    throw new Error(`${label}.lat must be between -90 and 90 degrees (received ${point.lat}).`);
  }
  if (point.lon < -180 || point.lon > 180) {
    throw new Error(`${label}.lon must be between -180 and 180 degrees (received ${point.lon}).`);
  }
}

/** Wrap an angle in degrees into [0, 360). */
function normalizeAzimuth(deg: number): number {
  const wrapped = deg % 360;
  return wrapped < 0 ? wrapped + 360 : wrapped;
}

/** Wrap a longitude in degrees into [-180, 180). */
function normalizeLongitude(deg: number): number {
  if (deg >= -180 && deg < 180) return deg;
  return (((deg + 180) % 360) + 360) % 360 - 180;
}

function geodesicResultNumber(value: number | undefined, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Geodesic ${label} computation failed.`);
  }
  return value;
}

/* ------------------------------------------------------------------------- */
/* DMS parsing / formatting                                                  */
/* ------------------------------------------------------------------------- */

const HEMISPHERE_SIGN: Readonly<Record<string, number>> = { N: 1, S: -1, E: 1, W: -1 };

/** Characters that may appear in a DMS string but never inside a number. */
const DMS_SEPARATOR_CHARS = /[°'"\s,.:]/;

/** Normalise exotic unicode variants of degree/minute/second signs and spaces. */
function normalizeDmsText(input: string): string {
  return input
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .replace(/[º˚°]/g, '°')
    .replace(/[′’‘`´]/g, "'")
    .replace(/[″”“]/g, '"')
    .replace(/[−–—]/g, '-')
    .trim();
}

/** Parse one numeric token, accepting a comma as a decimal separator when it
 *  is the only separator, or as a thousands separator when a dot is present. */
function parseNumericToken(token: string): number | null {
  const hasComma = token.includes(',');
  const hasDot = token.includes('.');
  let normalised = token;
  if (hasComma && hasDot) {
    normalised = token.replace(/,/g, '');
  } else if (hasComma) {
    if ((token.match(/,/g) ?? []).length !== 1) return null;
    normalised = token.replace(',', '.');
  }
  const value = Number(normalised);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a DMS or decimal-degree string.
 *
 * Accepted forms include `1°23'45.6"S`, `1 23 45.6 S`, `-1.396`,
 * `36°49'18.8"E`, `36.8208333E`, `1°23.5'`, unicode primes
 * (`′`, `″`, `’`, `”`) and a leading or trailing hemisphere letter.
 *
 * @returns decimal degrees, or `null` when the text is not a valid angle.
 */
export function parseDMS(input: string): number | null {
  if (typeof input !== 'string') return null;
  let text = normalizeDmsText(input);
  if (text.length === 0) return null;

  // Hemisphere letter: only a leading or trailing standalone N/S/E/W is valid.
  let hemisphere: string | null = null;
  const trailing = text.match(/([NSEW])\s*$/i);
  if (trailing && typeof trailing.index === 'number') {
    hemisphere = trailing[1].toUpperCase();
    text = text.slice(0, trailing.index).trim();
  }
  const leading = text.match(/^([NSEW])\s+/i) ?? text.match(/^([NSEW])(?=\d)/i);
  if (leading) {
    if (hemisphere !== null) return null; // hemisphere on both ends: ambiguous
    hemisphere = leading[1].toUpperCase();
    text = text.slice(leading[0].length).trim();
  }
  if (text.length === 0) return null;
  if (/[A-Za-z]/.test(text)) return null;

  // Explicit sign in front of the degrees.
  let explicitNegative = false;
  if (/^[+-]/.test(text)) {
    explicitNegative = text.startsWith('-');
    text = text.slice(1).trim();
  }
  if (/[+-]/.test(text)) return null; // signs are only valid at the front
  if (text.length === 0) return null;

  if (!DMS_SEPARATOR_CHARS.test(text) && !/\d/.test(text)) return null;
  // Anything other than digits and separators is invalid.
  if (/[^0-9.,°'"\s:]/.test(text)) return null;

  text = text.replace(/:/g, ' ');
  const numberTokens = text.match(/\d+(?:[.,]\d+)?/g);
  if (!numberTokens || numberTokens.length === 0 || numberTokens.length > 3) return null;

  // Whatever is left after removing numbers and separators must be empty.
  const residue = text
    .replace(/\d+(?:[.,]\d+)?/g, '')
    .replace(/[°'"\s.,:]/g, '');
  if (residue.length > 0) return null;

  const degrees = parseNumericToken(numberTokens[0]);
  if (degrees === null) return null;

  let minutes = 0;
  let seconds = 0;
  if (numberTokens.length >= 2) {
    if (!Number.isInteger(degrees)) return null; // DMS degrees must be integral
    const parsedMinutes = parseNumericToken(numberTokens[1]);
    if (parsedMinutes === null || parsedMinutes < 0 || parsedMinutes >= 60) return null;
    minutes = parsedMinutes;
  }
  if (numberTokens.length === 3) {
    const parsedSeconds = parseNumericToken(numberTokens[2]);
    if (parsedSeconds === null || parsedSeconds < 0 || parsedSeconds >= 60) return null;
    seconds = parsedSeconds;
  }

  const magnitude = degrees + minutes / 60 + seconds / 3600;
  if (!Number.isFinite(magnitude) || magnitude > 180) return null;

  const hemisphereSign = hemisphere === null ? null : HEMISPHERE_SIGN[hemisphere];
  const negative = hemisphereSign !== null ? hemisphereSign < 0 || explicitNegative : explicitNegative;
  const value = negative ? -magnitude : magnitude;
  return Object.is(value, -0) ? 0 : value;
}

function assertFormatDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error('decimals must be an integer between 0 and 12.');
  }
}

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

type HemisphereAxis = 'auto' | 'lat' | 'lon';

function hemisphereFor(deg: number, axis: HemisphereAxis): string {
  const negative = deg < 0;
  if (axis === 'lat') return negative ? 'S' : 'N';
  if (axis === 'lon') return negative ? 'W' : 'E';
  // Without an axis hint, only unambiguous magnitudes can be classified:
  // anything beyond 90° must be a longitude.
  if (Math.abs(deg) > 90) return negative ? 'W' : 'E';
  return negative ? 'S' : 'N';
}

/**
 * Format decimal degrees as DMS, e.g. `1°23′45.6″S`.
 *
 * The optional third argument disambiguates the hemisphere for longitude
 * values (an additive, backwards-compatible extension of the frozen contract).
 */
export function formatDMS(deg: number, decimals = 1, axis: HemisphereAxis = 'auto'): string {
  assertFiniteNumber(deg, 'deg');
  assertFormatDecimals(decimals);

  const hemisphere = hemisphereFor(deg, axis);
  const absolute = Math.abs(deg);
  let degrees = Math.floor(absolute);
  const minutesFloat = (absolute - degrees) * 60;
  let minutes = Math.floor(minutesFloat);
  let seconds = Number(((minutesFloat - minutes) * 60).toFixed(decimals));
  if (seconds >= 60) {
    seconds = Number((seconds - 60).toFixed(decimals));
    minutes += 1;
  }
  if (minutes >= 60) {
    minutes -= 60;
    degrees += 1;
  }
  const [secondsWhole, secondsFraction] = seconds.toFixed(decimals).split('.');
  const secondsText =
    secondsFraction === undefined
      ? secondsWhole.padStart(2, '0')
      : `${secondsWhole.padStart(2, '0')}.${secondsFraction}`;
  return `${degrees}°${pad2(minutes)}′${secondsText}″${hemisphere}`;
}

/**
 * Format decimal degrees with fixed decimals and a hemisphere tag,
 * e.g. `1.396389°S`. The optional third argument is the same axis hint as
 * `formatDMS`.
 */
export function formatDD(deg: number, decimals = 6, axis: HemisphereAxis = 'auto'): string {
  assertFiniteNumber(deg, 'deg');
  assertFormatDecimals(decimals);
  return `${Math.abs(deg).toFixed(decimals)}°${hemisphereFor(deg, axis)}`;
}

/* ------------------------------------------------------------------------- */
/* Geodesic problems                                                         */
/* ------------------------------------------------------------------------- */

/** Inverse geodesic problem on WGS 84. Azimuths are returned in [0, 360). */
export function geodesicInverse(a: LatLon, b: LatLon): {
  distance: number;
  azi1: number;
  azi2: number;
} {
  assertLatLon(a, 'First point');
  assertLatLon(b, 'Second point');
  const result = GEOD.Inverse(a.lat, a.lon, b.lat, b.lon);
  return {
    distance: geodesicResultNumber(result.s12, 'inverse distance'),
    azi1: normalizeAzimuth(geodesicResultNumber(result.azi1, 'inverse azimuth')),
    azi2: normalizeAzimuth(geodesicResultNumber(result.azi2, 'inverse azimuth')),
  };
}

/** Direct geodesic problem: point reached from `start` on `azimuth` after `distance` metres. */
export function geodesicDirect(start: LatLon, azimuth: number, distance: number): LatLon {
  assertLatLon(start, 'Start point');
  assertFiniteNumber(azimuth, 'azimuth');
  assertFiniteNumber(distance, 'distance');
  if (distance < 0) {
    throw new Error('distance must be greater than or equal to 0 metres.');
  }
  const result = GEOD.Direct(start.lat, start.lon, azimuth, distance);
  const lat = geodesicResultNumber(result.lat2, 'direct latitude');
  const lon = geodesicResultNumber(result.lon2, 'direct longitude');
  return { lat, lon: normalizeLongitude(lon) };
}

const DEFAULT_MAX_SAMPLES = 500;
const DEFAULT_INTERVAL_M = 50;

function assertSamplingOptions(maxSamples: number, intervalM: number): void {
  if (!Number.isInteger(maxSamples) || maxSamples < 2) {
    throw new Error('maxSamples must be an integer greater than or equal to 2.');
  }
  if (!Number.isFinite(intervalM) || intervalM <= 0) {
    throw new Error('intervalM must be a finite number greater than 0 metres.');
  }
}

/** Number of samples for a line, honouring an interval floor and a hard cap. */
function sampleCountFor(distance: number, maxSamples: number, intervalM: number): number {
  if (distance <= 0) return 2;
  const ideal = Math.floor(distance / intervalM) + 1;
  return Math.max(2, Math.min(maxSamples, ideal));
}

/**
 * Sample a geodesic line between two points.
 *
 * `intervalM` is a spacing floor: adjacent samples are never closer together
 * than that, and `maxSamples` caps the total (endpoints always included).
 */
export function geodesicPath(
  a: LatLon,
  b: LatLon,
  maxSamples = DEFAULT_MAX_SAMPLES,
  intervalM = DEFAULT_INTERVAL_M,
): LatLon[] {
  assertLatLon(a, 'First point');
  assertLatLon(b, 'Second point');
  assertSamplingOptions(maxSamples, intervalM);

  const inverse = geodesicInverse(a, b);
  const total = inverse.distance;
  if (total === 0) return [{ ...a }, { ...b }];

  const count = sampleCountFor(total, maxSamples, intervalM);
  const points: LatLon[] = [{ ...a }];
  for (let i = 1; i < count - 1; i += 1) {
    points.push(geodesicDirect(a, inverse.azi1, (total * i) / (count - 1)));
  }
  points.push({ ...b }); // exact endpoint, no accumulated drift
  return points;
}

/**
 * Sample a multi-vertex geodesic polyline, preserving every input vertex.
 *
 * Interior samples are allocated across segments proportionally to segment
 * length. If `maxSamples` is smaller than the vertex count the vertices win:
 * the cap applies to interior sampling only.
 */
export function geodesicPolylinePath(
  points: LatLon[],
  maxSamples = DEFAULT_MAX_SAMPLES,
  intervalM = DEFAULT_INTERVAL_M,
): { points: LatLon[]; cumulative: number[]; totalDistance: number } {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('A polyline needs at least 2 points.');
  }
  points.forEach((point, index) => assertLatLon(point, `Point ${index + 1}`));
  assertSamplingOptions(maxSamples, intervalM);

  const segments = [];
  let totalDistance = 0;
  for (let i = 1; i < points.length; i += 1) {
    const inverse = geodesicInverse(points[i - 1], points[i]);
    segments.push({ start: points[i - 1], inverse });
    totalDistance += inverse.distance;
  }

  if (totalDistance === 0) {
    return {
      points: points.map((point) => ({ ...point })),
      cumulative: points.map(() => 0),
      totalDistance: 0,
    };
  }

  const target = Math.max(points.length, sampleCountFor(totalDistance, maxSamples, intervalM));
  const interiorBudget = target - points.length;

  // Largest-remainder allocation of interior samples to segments.
  const ideal = segments.map((segment) => (segment.inverse.distance / totalDistance) * interiorBudget);
  const allocation = ideal.map((value) => Math.floor(value));
  let allocated = allocation.reduce((sum, value) => sum + value, 0);
  if (allocated < interiorBudget) {
    const byRemainder = ideal
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .sort((left, right) => right.remainder - left.remainder);
    let cursor = 0;
    while (allocated < interiorBudget) {
      allocation[byRemainder[cursor % byRemainder.length].index] += 1;
      allocated += 1;
      cursor += 1;
    }
  }

  const sampled: LatLon[] = [];
  const cumulative: number[] = [];
  let travelled = 0;
  sampled.push({ ...points[0] });
  cumulative.push(0);

  segments.forEach((segment, segmentIndex) => {
    const segmentStart = travelled;
    const interior = allocation[segmentIndex];
    const stepCount = interior + 1;
    for (let step = 1; step <= interior; step += 1) {
      const along = (segment.inverse.distance * step) / stepCount;
      sampled.push(geodesicDirect(segment.start, segment.inverse.azi1, along));
      cumulative.push(segmentStart + along);
    }
    travelled = segmentStart + segment.inverse.distance;
    sampled.push({ ...points[segmentIndex + 1] });
    cumulative.push(travelled);
  });

  return { points: sampled, cumulative, totalDistance };
}

/** Normalise a ring for the geodesic area routine (drop the closing duplicate). */
function normalizeRing(points: LatLon[]): LatLon[] {
  if (points.length < 2) return points;
  const first = points[0];
  const last = points[points.length - 1];
  const closed = Math.abs(first.lat - last.lat) < 1e-12 && Math.abs(first.lon - last.lon) < 1e-12;
  return closed ? points.slice(0, -1) : points;
}

/** Geodesic polygon area and perimeter on the WGS 84 ellipsoid (Karney). */
export function geodesicPolygonArea(points: LatLon[]): { area: number; perimeter: number } {
  if (!Array.isArray(points) || points.length < 3) {
    throw new Error('A geodesic polygon needs at least 3 vertices.');
  }
  points.forEach((point, index) => assertLatLon(point, `Vertex ${index + 1}`));
  const ring = normalizeRing(points);
  if (ring.length < 3) {
    throw new Error('A geodesic polygon needs at least 3 distinct vertices.');
  }

  const polygon = new PolygonAreaConstructor(GEOD, false);
  for (const point of ring) {
    polygon.AddPoint(point.lat, point.lon);
  }
  const result = polygon.Compute(false, true);
  const area = result.area;
  const perimeter = result.perimeter;
  if (typeof area !== 'number' || !Number.isFinite(area)) {
    throw new Error('Geodesic polygon area computation failed.');
  }
  if (typeof perimeter !== 'number' || !Number.isFinite(perimeter)) {
    throw new Error('Geodesic polygon perimeter computation failed.');
  }
  return { area: Math.abs(area), perimeter };
}
