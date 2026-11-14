/**
 * Geodesia — polygon area engine
 * ---------------------------------------------------------------------------
 * One computation for both supported polygon input modes:
 *   - `xy`     : local Cartesian coordinates in metres → Gaussian shoelace.
 *   - `latlon` : WGS 84 degrees → planar values on a local tangent plane for
 *                comparison, plus Karney ellipsoidal area/perimeter.
 *
 * A ring is always treated as closed. When the last vertex is not a duplicate
 * of the first one, the ring is closed implicitly and the length of that
 * closing edge is reported as `closure` (misclosure in metres). For an
 * explicitly closed ring — the normal output of the polygon table's
 * auto-close — the closure is exactly 0.
 */
import type {
  AreaMode,
  AreaResult,
  AreaSegment,
  AreaUnits,
  LatLon,
  Vertex,
  XYPoint,
} from './types';
import { geodesicInverse, geodesicPolygonArea, WGS84 } from './geodesy';
import { centroid2D, perimeter2D, shoelaceArea } from './shoelace';
import { findAreaUnit } from './units';

const DEGREE = Math.PI / 180;

/** Round a planar bearing into [0, 360). */
function bearingFromDelta(dx: number, dy: number): number {
  const degrees = (Math.atan2(dx, dy) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

function assertFinitePoint(value: XYPoint | LatLon, index: number): void {
  if (!value || typeof value !== 'object') {
    throw new Error(`Vertex ${index + 1} must be an object.`);
  }
}

/** Drop an explicit closing duplicate and validate the ring size. */
function prepareRing<T extends XYPoint | LatLon>(points: T[], equals: (a: T, b: T) => boolean): T[] {
  if (!Array.isArray(points)) {
    throw new Error('Points must be an array of vertices.');
  }
  if (points.length < 3) {
    throw new Error(`A polygon needs at least 3 vertices (received ${points.length}).`);
  }
  points.forEach(assertFinitePoint);
  const first = points[0];
  const last = points[points.length - 1];
  const ring = equals(first, last) ? points.slice(0, -1) : points;
  if (ring.length < 3) {
    throw new Error(`A polygon needs at least 3 distinct vertices (received ${ring.length}).`);
  }
  return ring;
}

function pointsEqualXY(a: XYPoint, b: XYPoint): boolean {
  return Math.abs(a.x - b.x) <= 1e-9 && Math.abs(a.y - b.y) <= 1e-9;
}

function pointsEqualLatLon(a: LatLon, b: LatLon): boolean {
  return Math.abs(a.lat - b.lat) <= 1e-12 && Math.abs(a.lon - b.lon) <= 1e-12;
}

/**
 * Local east/north scale factors at a latitude, per radian:
 *   N = a / sqrt(1 - e² sin²φ)      (prime-vertical radius, east direction)
 *   M = a(1 - e²) / (1 - e² sin²φ)^1.5  (meridional radius, north direction)
 * Using M and N (instead of a single sphere radius) makes the local planar
 * area of a small plot agree with the ellipsoidal geodesic area to ~1e-7
 * relative, which is what the planar-vs-geodesic comparison needs.
 */
function localRadii(lat: number): { m: number; n: number; cosLat: number } {
  const phi = lat * DEGREE;
  const sinPhi = Math.sin(phi);
  const w = Math.sqrt(1 - WGS84.e2 * sinPhi * sinPhi);
  const n = WGS84.a / w;
  const m = (WGS84.a * (1 - WGS84.e2)) / (w * w * w);
  const cosLat = Math.cos(phi);
  // Guard degenerate polar geometry so no Infinity/NaN can escape.
  return { m, n, cosLat: Math.abs(cosLat) < 1e-12 ? 0 : cosLat };
}

/** Project geographic vertices onto a local tangent plane (metres). */
function toLocalPlane(points: LatLon[]): XYPoint[] {
  const origin = points[0];
  const { m, n, cosLat } = localRadii(origin.lat);
  return points.map((point) => {
    let deltaLon = point.lon - origin.lon;
    if (deltaLon > 180) deltaLon -= 360;
    if (deltaLon < -180) deltaLon += 360;
    return {
      x: deltaLon * DEGREE * n * cosLat,
      y: (point.lat - origin.lat) * DEGREE * m,
    };
  });
}

/** Invert `toLocalPlane` for the planar centroid of a geographic ring. */
function fromLocalPlane(point: XYPoint, origin: LatLon): LatLon {
  const { m, n, cosLat } = localRadii(origin.lat);
  const eastScale = n * cosLat;
  return {
    lat: origin.lat + point.y / (m * DEGREE),
    lon: eastScale === 0 ? origin.lon : origin.lon + point.x / (eastScale * DEGREE),
  };
}

function vertexLabel(index: number): string {
  return `P${index + 1}`;
}

/** Convert a square-metre magnitude into the full unit set. */
export function toAreaUnits(m2: number): AreaUnits {
  if (typeof m2 !== 'number' || !Number.isFinite(m2)) {
    throw new Error('Area must be a finite number of square metres.');
  }
  return {
    m2,
    ha: m2 / findAreaUnit('ha').factor,
    acres: m2 / findAreaUnit('acres').factor,
    km2: m2 / findAreaUnit('km2').factor,
    ft2: m2 / findAreaUnit('ft2').factor,
    roods: m2 / findAreaUnit('roods').factor,
    guntas: m2 / findAreaUnit('guntas').factor,
  };
}

function validateGeographicPoints(points: LatLon[]): void {
  points.forEach((point, index) => {
    if (typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      throw new Error(`Vertex ${index + 1} has an invalid latitude (expected -90..90 degrees).`);
    }
    if (typeof point.lon !== 'number' || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
      throw new Error(`Vertex ${index + 1} has an invalid longitude (expected -180..180 degrees).`);
    }
  });
}

function computeXYResult(points: XYPoint[]): AreaResult {
  const ring = prepareRing(points, pointsEqualXY);
  const planarArea = shoelaceArea(ring);
  const planarPerimeter = perimeter2D(ring);
  const centroid = centroid2D(ring);
  const closing = pointsEqualXY(points[0], points[points.length - 1]);
  const closure = closing ? 0 : Math.hypot(points[points.length - 1].x - points[0].x, points[points.length - 1].y - points[0].y);

  const segments: AreaSegment[] = ring.map((point, index) => {
    const next = ring[(index + 1) % ring.length];
    const dx = next.x - point.x;
    const dy = next.y - point.y;
    return {
      index,
      from: vertexLabel(index),
      to: vertexLabel((index + 1) % ring.length),
      planDistance: Math.hypot(dx, dy),
      geodesicDistance: null,
      bearing: bearingFromDelta(dx, dy),
    };
  });

  const warnings: string[] = [];
  if (!closing && ring.length !== points.length) {
    // Defensive only: prepareRing strips a duplicate under the same predicate.
    warnings.push('The closing duplicate vertex was removed before computing the area.');
  }

  return {
    mode: 'xy',
    vertexCount: ring.length,
    planarArea,
    planarPerimeter,
    geodesicArea: null,
    geodesicPerimeter: null,
    closure,
    centroid,
    units: toAreaUnits(planarArea),
    segments,
    warnings,
  };
}

function computeLatLonResult(points: LatLon[]): AreaResult {
  validateGeographicPoints(points);
  const ring = prepareRing(points, pointsEqualLatLon);
  validateGeographicPoints(ring);

  const planarPoints = toLocalPlane(ring);
  const planarArea = shoelaceArea(planarPoints);
  const planarPerimeter = perimeter2D(planarPoints);

  const geodesic = geodesicPolygonArea(ring);
  const centroidPlanar = centroid2D(planarPoints);
  const centroid = fromLocalPlane(centroidPlanar, ring[0]);

  const closing = pointsEqualLatLon(points[0], points[points.length - 1]);
  const closure = closing ? 0 : geodesicInverse(points[points.length - 1], points[0]).distance;

  const segments: AreaSegment[] = ring.map((point, index) => {
    const next = ring[(index + 1) % ring.length];
    const planarFrom = planarPoints[index];
    const planarTo = planarPoints[(index + 1) % ring.length];
    const inverse = geodesicInverse(point, next);
    return {
      index,
      from: vertexLabel(index),
      to: vertexLabel((index + 1) % ring.length),
      planDistance: Math.hypot(planarTo.x - planarFrom.x, planarTo.y - planarFrom.y),
      geodesicDistance: inverse.distance,
      bearing: inverse.azi1,
    };
  });

  const warnings: string[] = [];
  if (geodesic.area <= 0) {
    warnings.push('Geodesic area is zero; check for collinear or duplicated vertices.');
  }

  return {
    mode: 'latlon',
    vertexCount: ring.length,
    planarArea,
    planarPerimeter,
    geodesicArea: geodesic.area,
    geodesicPerimeter: geodesic.perimeter,
    closure,
    centroid,
    units: toAreaUnits(geodesic.area),
    segments,
    warnings,
  };
}

/** Full polygon-area computation for both supported input modes. */
export function computePolygonArea(
  input:
    | {
        mode: 'xy';
        points: XYPoint[];
      }
    | {
        mode: 'latlon';
        points: LatLon[];
      },
): AreaResult {
  if (!input || typeof input !== 'object') {
    throw new Error('computePolygonArea expects { mode, points }.');
  }
  if (input.mode === 'xy') {
    return computeXYResult(input.points);
  }
  if (input.mode === 'latlon') {
    return computeLatLonResult(input.points);
  }
  throw new Error('mode must be "xy" or "latlon".');
}

// Re-exported for convenience of consumers that only import from this module.
export type { AreaMode, Vertex };
