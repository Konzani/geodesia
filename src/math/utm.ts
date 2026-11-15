/**
 * Geodesia — UTM projection engine (in-house Krüger series)
 * ---------------------------------------------------------------------------
 * WGS 84 transverse Mercator computed directly with Karney's order-6 Krüger
 * series. No projection dependency, no lazy chunk, no network: the engine is
 * always part of the math module. Forward accuracy is sub-nanometre across a
 * UTM zone (verified against fixed reference values in the tests); the inverse
 * is solved by Newton iteration on the forward mapping, so both directions are
 * self-consistent to well below a micrometre.
 *
 * Constants: a = 6 378 137 m, e² = 0.0066943799901413165, k0 = 0.9996,
 * false easting 500 000 m, southern false northing 10 000 000 m.
 *
 * `loadUtmEngine()` and `isUtmEngineLoaded()` are retained for API
 * compatibility with callers written against the previous load-on-demand
 * engine. The engine is now always built in, so loading resolves immediately
 * and the helpers are always ready.
 */
import type { Hemisphere, UtmParams, UtmPoint } from './polygon-types';
import type { LatLon } from './types';

const WGS84_A = 6378137;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = WGS84_F * (2 - WGS84_F);
const WGS84_E = Math.sqrt(WGS84_E2);
const UTM_K0 = 0.9996;
const FALSE_EASTING = 500000;
const FALSE_NORTHING_SOUTH = 10000000;

const DEGREES_TO_RADIANS = Math.PI / 180;
const RADIANS_TO_DEGREES = 180 / Math.PI;

/** Ellipsoid constants used by the CSF estimate (WGS 84 + UTM k0). */
export const UTM_CONSTANTS: {
  a: number;
  e2: number;
  k0: number;
  falseEasting: number;
  falseNorthingSouth: number;
} = {
  a: WGS84_A,
  e2: WGS84_E2,
  k0: UTM_K0,
  falseEasting: FALSE_EASTING,
  falseNorthingSouth: FALSE_NORTHING_SOUTH,
};

/* ------------------------------------------------------------------------- */
/* Krüger order-6 series                                                     */
/* ------------------------------------------------------------------------- */

/** Third flattening n = f / (2 − f). */
const N_SERIES = WGS84_F / (2 - WGS84_F);

/** Rectifying radius A = a/(1+n) · (1 + n²/4 + n⁴/64 + n⁶/256). */
const RECTIFYING_RADIUS =
  (WGS84_A / (1 + N_SERIES)) *
  (1 + N_SERIES ** 2 / 4 + N_SERIES ** 4 / 64 + N_SERIES ** 6 / 256);

/** Forward coefficients α₁…α₆ (Karney 2011, "Transverse Mercator with an
 *  accuracy of a few nanometers", eq. 35–36). */
const ALPHA: readonly number[] = [
  N_SERIES / 2 -
    (2 * N_SERIES ** 2) / 3 +
    (5 * N_SERIES ** 3) / 16 +
    (41 * N_SERIES ** 4) / 180 -
    (127 * N_SERIES ** 5) / 288 +
    (7891 * N_SERIES ** 6) / 37800,
  (13 * N_SERIES ** 2) / 48 -
    (3 * N_SERIES ** 3) / 5 +
    (557 * N_SERIES ** 4) / 1440 +
    (281 * N_SERIES ** 5) / 630 -
    (1983433 * N_SERIES ** 6) / 1935360,
  (61 * N_SERIES ** 3) / 240 -
    (103 * N_SERIES ** 4) / 140 +
    (15061 * N_SERIES ** 5) / 26880 +
    (167603 * N_SERIES ** 6) / 181440,
  (49561 * N_SERIES ** 4) / 161280 -
    (179 * N_SERIES ** 5) / 168 +
    (6601661 * N_SERIES ** 6) / 7257600,
  (34729 * N_SERIES ** 5) / 80640 - (3418889 * N_SERIES ** 6) / 1995840,
  (212378941 * N_SERIES ** 6) / 319334400,
];

const INVERSE_MAX_ITERATIONS = 20;
const INVERSE_TOLERANCE_M = 1e-7;
const JACOBIAN_STEP_DEG = 1e-6;

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                        */
/* ------------------------------------------------------------------------- */

function assertZone(zone: number): void {
  if (typeof zone !== 'number' || !Number.isInteger(zone) || zone < 1 || zone > 60) {
    throw new Error(`UTM zone must be an integer between 1 and 60 (received ${String(zone)}).`);
  }
}

function assertHemisphere(hemisphere: Hemisphere): void {
  if (hemisphere !== 'N' && hemisphere !== 'S') {
    throw new Error(`UTM hemisphere must be 'N' or 'S' (received ${String(hemisphere)}).`);
  }
}

function assertLatLon(point: LatLon): void {
  if (!point || typeof point !== 'object') {
    throw new Error('A geographic point must be a { lat, lon } object.');
  }
  if (typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
    throw new Error(`Latitude must be a finite number between -90 and 90 degrees (received ${String(point.lat)}).`);
  }
  if (typeof point.lon !== 'number' || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
    throw new Error(`Longitude must be a finite number between -180 and 180 degrees (received ${String(point.lon)}).`);
  }
}

function normalizeLongitude(degrees: number): number {
  if (degrees >= -180 && degrees < 180) return degrees;
  return (((degrees + 180) % 360) + 360) % 360 - 180;
}

/** Central meridian of a UTM zone, in degrees. */
function zoneCentralMeridian(zone: number): number {
  return zone * 6 - 183;
}

/* ------------------------------------------------------------------------- */
/* Forward projection                                                        */
/* ------------------------------------------------------------------------- */

function forwardToMeters(
  lat: number,
  lon: number,
  zone: number,
  hemisphere: Hemisphere,
): { E: number; N: number } {
  const phi = lat * DEGREES_TO_RADIANS;
  const lambda = lon * DEGREES_TO_RADIANS;
  const lambda0 = zoneCentralMeridian(zone) * DEGREES_TO_RADIANS;
  const deltaLambda = lambda - lambda0;

  // t = tan(χ), χ the conformal latitude (order-6 equivalent of the n-series).
  const t = Math.sinh(Math.asinh(Math.tan(phi)) - WGS84_E * Math.atanh(WGS84_E * Math.sin(phi)));
  const xiPrime = Math.atan2(t, Math.cos(deltaLambda));
  const etaPrime = Math.asinh(
    Math.sin(deltaLambda) / Math.sqrt(t * t + Math.cos(deltaLambda) ** 2),
  );

  let xi = xiPrime;
  let eta = etaPrime;
  for (let j = 1; j <= 6; j += 1) {
    xi += ALPHA[j - 1] * Math.sin(2 * j * xiPrime) * Math.cosh(2 * j * etaPrime);
    eta += ALPHA[j - 1] * Math.cos(2 * j * xiPrime) * Math.sinh(2 * j * etaPrime);
  }

  return {
    E: FALSE_EASTING + UTM_K0 * RECTIFYING_RADIUS * eta,
    N: (hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0) + UTM_K0 * RECTIFYING_RADIUS * xi,
  };
}

/* ------------------------------------------------------------------------- */
/* Inverse projection (Newton iteration on the forward mapping)              */
/* ------------------------------------------------------------------------- */

function inverseFromMeters(
  E: number,
  N: number,
  zone: number,
  hemisphere: Hemisphere,
): LatLon {
  const northingOffset = hemisphere === 'S' ? FALSE_NORTHING_SOUTH : 0;
  const lambda0 = zoneCentralMeridian(zone);

  // Leading-order starting guess: ξ ≈ η → rectifying latitude, η ≈ Δλ·cos χ.
  const scaledNorthing = (N - northingOffset) / (UTM_K0 * RECTIFYING_RADIUS);
  const scaledEasting = (E - FALSE_EASTING) / (UTM_K0 * RECTIFYING_RADIUS);
  let lat = scaledNorthing * RADIANS_TO_DEGREES;
  const cosGuess = Math.cos(scaledNorthing);
  let lon = lambda0 + (scaledEasting / (Math.abs(cosGuess) < 1e-6 ? 1e-6 * Math.sign(cosGuess || 1) : cosGuess)) * RADIANS_TO_DEGREES;

  for (let iteration = 0; iteration < INVERSE_MAX_ITERATIONS; iteration += 1) {
    const projected = forwardToMeters(lat, lon, zone, hemisphere);
    const residualE = projected.E - E;
    const residualN = projected.N - N;
    if (Math.abs(residualE) < INVERSE_TOLERANCE_M && Math.abs(residualN) < INVERSE_TOLERANCE_M) {
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
        throw new Error('UTM inverse projection produced an invalid latitude.');
      }
      return { lat, lon: normalizeLongitude(lon) };
    }

    const north = forwardToMeters(lat + JACOBIAN_STEP_DEG, lon, zone, hemisphere);
    const east = forwardToMeters(lat, lon + JACOBIAN_STEP_DEG, zone, hemisphere);
    const j11 = (north.E - projected.E) / JACOBIAN_STEP_DEG;
    const j21 = (north.N - projected.N) / JACOBIAN_STEP_DEG;
    const j12 = (east.E - projected.E) / JACOBIAN_STEP_DEG;
    const j22 = (east.N - projected.N) / JACOBIAN_STEP_DEG;
    const determinant = j11 * j22 - j12 * j21;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) {
      break;
    }

    const deltaLat = (-residualE * j22 + residualN * j12) / determinant;
    const deltaLon = (residualE * j21 - residualN * j11) / determinant;
    lat += deltaLat;
    lon += deltaLon;
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      break;
    }
  }

  throw new Error(
    `UTM inverse projection failed to converge for E ${E}, N ${N} (zone ${zone}${hemisphere}).`,
  );
}

/* ------------------------------------------------------------------------- */
/* Public API                                                                */
/* ------------------------------------------------------------------------- */

/**
 * Resolve when the UTM engine is ready. The engine is always built in now, so
 * this resolves immediately; the function is kept so existing callers that
 * `await loadUtmEngine()` continue to work unchanged.
 */
export async function loadUtmEngine(): Promise<void> {
  // No asynchronous work remains: the Krüger engine above is part of this module.
}

/** The UTM engine is always available synchronously. */
export function isUtmEngineLoaded(): boolean {
  return true;
}

/**
 * Human-readable UTM reference definition (now documents the projection
 * parameters and EPSG code rather than an external-engine definition string).
 */
export function utmDefinition(zone: number, hemisphere: Hemisphere): string {
  assertZone(zone);
  assertHemisphere(hemisphere);
  const epsg = (hemisphere === 'S' ? 32700 : 32600) + zone;
  return `WGS 84 / UTM zone ${zone}${hemisphere} (EPSG:${epsg})`;
}

/**
 * UTM zone + hemisphere for a geographic position.
 * Zone = floor((lon + 180) / 6) + 1, clamped to 1..60; hemisphere from the sign
 * of the latitude (equator counts as north).
 */
export function utmZoneFromLonLat(lon: number, lat: number): UtmParams {
  if (typeof lon !== 'number' || !Number.isFinite(lon) || lon < -180 || lon > 180) {
    throw new Error(`Longitude must be a finite number between -180 and 180 degrees (received ${String(lon)}).`);
  }
  if (typeof lat !== 'number' || !Number.isFinite(lat) || lat < -90 || lat > 90) {
    throw new Error(`Latitude must be a finite number between -90 and 90 degrees (received ${String(lat)}).`);
  }
  const rawZone = Math.floor((lon + 180) / 6) + 1;
  const zone = Math.min(60, Math.max(1, rawZone));
  return { zone, hemisphere: lat >= 0 ? 'N' : 'S' };
}

/** Forward projection WGS 84 → UTM (synchronous, always available). */
export function lonLatToUtm(point: LatLon, params: UtmParams): UtmPoint {
  assertLatLon(point);
  assertZone(params.zone);
  assertHemisphere(params.hemisphere);
  if (Math.abs(point.lat) >= 90) {
    throw new Error('UTM is undefined at the poles (|latitude| must be less than 90 degrees).');
  }
  const projected = forwardToMeters(point.lat, point.lon, params.zone, params.hemisphere);
  if (!Number.isFinite(projected.E) || !Number.isFinite(projected.N)) {
    throw new Error(`UTM forward projection failed for lon ${point.lon}, lat ${point.lat}.`);
  }
  return projected;
}

/** Inverse projection UTM → WGS 84 (synchronous, always available). */
export function utmToLonLat(point: UtmPoint, params: UtmParams): LatLon {
  if (!point || typeof point !== 'object') {
    throw new Error('A UTM point must be an { E, N } object.');
  }
  if (typeof point.E !== 'number' || !Number.isFinite(point.E)) {
    throw new Error(`UTM easting must be a finite number (received ${String(point.E)}).`);
  }
  if (typeof point.N !== 'number' || !Number.isFinite(point.N)) {
    throw new Error(`UTM northing must be a finite number (received ${String(point.N)}).`);
  }
  assertZone(params.zone);
  assertHemisphere(params.hemisphere);
  return inverseFromMeters(point.E, point.N, params.zone, params.hemisphere);
}

/**
 * Format a UTM easting/northing pair with survey-appropriate precision
 * (0.001 m, no thousands separators so values stay CSV/space-safe).
 */
export function formatUtm(point: UtmPoint): { E: string; N: string } {
  if (!point || typeof point !== 'object') {
    throw new Error('A UTM point must be an { E, N } object.');
  }
  if (typeof point.E !== 'number' || !Number.isFinite(point.E)) {
    throw new Error('UTM easting must be a finite number.');
  }
  if (typeof point.N !== 'number' || !Number.isFinite(point.N)) {
    throw new Error('UTM northing must be a finite number.');
  }
  return { E: point.E.toFixed(3), N: point.N.toFixed(3) };
}
