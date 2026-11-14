/**
 * Geodesia — planar polygon geometry
 * ---------------------------------------------------------------------------
 * Gaussian trapezoid ("shoelace") area, perimeter and centroid for local
 * Cartesian coordinates in metres. Coordinates are translated to the first
 * vertex before accumulating, which keeps the products small and avoids the
 * cancellation that plain shoelace suffers on large survey coordinates
 * (e.g. eastings around 200 000 m).
 *
 * Pure functions only. Invalid input throws an `Error` with a clear message.
 */
import type { XYPoint } from './types';

function assertPoint(point: XYPoint, index: number): void {
  if (!point || typeof point !== 'object') {
    throw new Error(`Vertex ${index + 1} must be an { x, y } object.`);
  }
  if (typeof point.x !== 'number' || !Number.isFinite(point.x)) {
    throw new Error(`Vertex ${index + 1} has a non-finite x coordinate.`);
  }
  if (typeof point.y !== 'number' || !Number.isFinite(point.y)) {
    throw new Error(`Vertex ${index + 1} has a non-finite y coordinate.`);
  }
}

function assertRing(points: XYPoint[], minimum: number): XYPoint[] {
  if (!Array.isArray(points)) {
    throw new Error('Points must be an array of { x, y } vertices.');
  }
  if (points.length < minimum) {
    throw new Error(`A polygon needs at least ${minimum} distinct vertices (received ${points.length}).`);
  }
  points.forEach(assertPoint);
  // Drop an explicit closing duplicate (last === first).
  const first = points[0];
  const last = points[points.length - 1];
  const closed = Math.abs(first.x - last.x) <= 1e-12 && Math.abs(first.y - last.y) <= 1e-12;
  const ring = closed ? points.slice(0, -1) : points;
  if (ring.length < minimum) {
    throw new Error(`A polygon needs at least ${minimum} distinct vertices (received ${ring.length}).`);
  }
  return ring;
}

/**
 * Signed planar area (m²) via the Gaussian trapezoid formula.
 * Positive for counter-clockwise vertex order, negative for clockwise.
 */
export function signedArea(points: XYPoint[]): number {
  const ring = assertRing(points, 3);
  const originX = ring[0].x;
  const originY = ring[0].y;

  let twiceArea = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    const x1 = current.x - originX;
    const y1 = current.y - originY;
    const x2 = next.x - originX;
    const y2 = next.y - originY;
    twiceArea += x1 * y2 - x2 * y1;
  }
  return twiceArea / 2;
}

/** Absolute planar area (m²) — the verified Gaussian shoelace result. */
export function shoelaceArea(points: XYPoint[]): number {
  const area = signedArea(points);
  return Math.abs(area);
}

/** Closed-ring planar perimeter (m). */
export function perimeter2D(points: XYPoint[]): number {
  const ring = assertRing(points, 2);
  let total = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    total += Math.hypot(next.x - current.x, next.y - current.y);
  }
  return total;
}

/**
 * Polygon area centroid for a closed ring.
 *
 * @throws if the polygon has zero area (the centroid is undefined).
 */
export function centroid2D(points: XYPoint[]): XYPoint {
  const ring = assertRing(points, 3);
  const originX = ring[0].x;
  const originY = ring[0].y;

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const current = ring[i];
    const next = ring[(i + 1) % ring.length];
    const x1 = current.x - originX;
    const y1 = current.y - originY;
    const x2 = next.x - originX;
    const y2 = next.y - originY;
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    cx += (x1 + x2) * cross;
    cy += (y1 + y2) * cross;
  }

  if (twiceArea === 0 || !Number.isFinite(twiceArea)) {
    throw new Error('Polygon has zero area; its centroid is undefined.');
  }

  return {
    x: cx / (3 * twiceArea) + originX,
    y: cy / (3 * twiceArea) + originY,
  };
}
