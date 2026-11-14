import { describe, expect, it } from 'vitest';
import {
  centroid2D,
  computePolygonArea,
  perimeter2D,
  shoelaceArea,
  signedArea,
  toAreaUnits,
} from '../index';

const SQUARE = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

describe('shoelace', () => {
  it('computes a 100 m x 100 m square as exactly 10 000 m²', () => {
    expect(shoelaceArea(SQUARE)).toBe(10000);
    expect(signedArea(SQUARE)).toBe(10000);
    expect(perimeter2D(SQUARE)).toBe(400);
  });

  it('reports signed area by winding direction', () => {
    const clockwise = [...SQUARE].reverse();
    expect(signedArea(clockwise)).toBe(-10000);
    expect(shoelaceArea(clockwise)).toBe(10000);
  });

  it('stays exact for large survey coordinates', () => {
    const translated = SQUARE.map((point) => ({ x: point.x + 200000, y: point.y + 1000000 }));
    expect(shoelaceArea(translated)).toBe(10000);
    const centroid = centroid2D(translated);
    expect(centroid.x).toBeCloseTo(200050, 6);
    expect(centroid.y).toBeCloseTo(1000050, 6);
  });

  it('accepts an explicit closing duplicate and finds the centroid', () => {
    expect(shoelaceArea([...SQUARE, { ...SQUARE[0] }])).toBe(10000);
    const centroid = centroid2D(SQUARE);
    expect(centroid.x).toBeCloseTo(50, 9);
    expect(centroid.y).toBeCloseTo(50, 9);
  });

  it('computes the centroid of a triangle', () => {
    const triangle = [
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 0, y: 60 },
    ];
    const centroid = centroid2D(triangle);
    expect(centroid.x).toBeCloseTo(10, 9);
    expect(centroid.y).toBeCloseTo(20, 9);
  });

  it('validates input and rejects degenerate rings for the centroid', () => {
    expect(() => shoelaceArea([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toThrow(/at least 3/);
    expect(() => shoelaceArea([{ x: 0, y: 0 }, { x: 1, y: Number.NaN }, { x: 2, y: 2 }])).toThrow(/non-finite/);
    expect(() =>
      centroid2D([
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 20, y: 0 },
      ]),
    ).toThrow(/zero area/);
  });
});

describe('toAreaUnits', () => {
  it('converts a square metre magnitude into every unit', () => {
    const units = toAreaUnits(10000);
    expect(units.m2).toBe(10000);
    expect(units.ha).toBe(1);
    expect(units.km2).toBe(0.01);
    expect(units.acres).toBeCloseTo(2.471053814671653, 9);
    expect(units.ft2).toBeCloseTo(107639.10416709722, 6);
    expect(units.roods).toBeCloseTo(10000 / 1011.7141056, 12);
    expect(units.guntas).toBeCloseTo(10000 / 101.17141056, 12);
    expect(() => toAreaUnits(Number.NaN)).toThrow(/finite/);
  });
});

describe('computePolygonArea — local Cartesian mode', () => {
  it('computes area, perimeter, centroid and segments for a square', () => {
    const result = computePolygonArea({ mode: 'xy', points: SQUARE });
    expect(result.mode).toBe('xy');
    expect(result.vertexCount).toBe(4);
    expect(result.planarArea).toBe(10000);
    expect(result.planarPerimeter).toBe(400);
    expect(result.geodesicArea).toBeNull();
    expect(result.geodesicPerimeter).toBeNull();
    expect(result.units.m2).toBe(10000);
    expect(result.units.ha).toBe(1);
    expect(result.centroid).toEqual({ x: 50, y: 50 });
    expect(result.segments).toHaveLength(4);
    // Out-of-the-box winding: first edge points east, then north, west, south.
    expect(result.segments[0].bearing).toBeCloseTo(90, 9);
    expect(result.segments[1].bearing).toBeCloseTo(0, 9);
    expect(result.segments[0].planDistance).toBe(100);
    expect(result.segments[0].geodesicDistance).toBeNull();
    expect(result.segments[0].from).toBe('P1');
    expect(result.segments[0].to).toBe('P2');
  });

  it('reports zero closure for an explicitly closed ring and the gap otherwise', () => {
    const closed = computePolygonArea({ mode: 'xy', points: [...SQUARE, { ...SQUARE[0] }] });
    expect(closed.closure).toBe(0);
    expect(closed.vertexCount).toBe(4);

    const open = computePolygonArea({ mode: 'xy', points: SQUARE });
    // The implicit closing edge runs from (0, 100) back to (0, 0).
    expect(open.closure).toBeCloseTo(100, 12);
  });

  it('validates the ring', () => {
    expect(() => computePolygonArea({ mode: 'xy', points: SQUARE.slice(0, 2) })).toThrow(/at least 3/);
    expect(() =>
      computePolygonArea({
        mode: 'xy',
        points: [
          { x: 0, y: 0 },
          { x: Number.NaN, y: 0 },
          { x: 1, y: 1 },
        ],
      }),
    ).toThrow(/non-finite/);
  });
});

describe('computePolygonArea — WGS 84 mode', () => {
  const ring = [
    { lat: -1.3, lon: 36.8 },
    { lat: -1.3, lon: 36.801 },
    { lat: -1.299, lon: 36.801 },
    { lat: -1.299, lon: 36.8 },
  ];

  it('computes geodesic and planar values for a small Nairobi plot', () => {
    const result = computePolygonArea({ mode: 'latlon', points: ring });
    expect(result.mode).toBe('latlon');
    expect(result.vertexCount).toBe(4);
    expect(result.geodesicArea).not.toBeNull();
    expect(result.geodesicPerimeter).not.toBeNull();
    expect(result.geodesicArea as number).toBeGreaterThan(0);
    // ~111 m x ~111 m plot.
    expect(result.geodesicArea as number).toBeCloseTo(111 * 111, -3);
    // The local tangent plane must agree with the ellipsoid to well under 0.1 %.
    expect(Math.abs((result.planarArea - (result.geodesicArea as number)) / (result.geodesicArea as number))).toBeLessThan(0.001);
    // Unit bundle is derived from the geodesic area.
    expect(result.units.ha).toBeCloseTo((result.geodesicArea as number) / 10000, 12);

    const centroid = result.centroid as { lat: number; lon: number };
    expect(centroid.lat).toBeGreaterThan(-1.3);
    expect(centroid.lat).toBeLessThan(-1.299);
    expect(centroid.lon).toBeGreaterThan(36.8);
    expect(centroid.lon).toBeLessThan(36.801);

    expect(result.segments[0].bearing).toBeCloseTo(90, 1);
    // 0.001° of longitude at latitude 1.3° south ≈ 111.29 m.
    expect(result.segments[0].geodesicDistance as number).toBeCloseTo(111.29, 1);
    expect(result.segments[0].planDistance).toBeGreaterThan(110);
    expect(result.segments[0].planDistance).toBeLessThan(112);
  });

  it('computes closure from the last vertex back to the first', () => {
    const closed = computePolygonArea({ mode: 'latlon', points: [...ring, { ...ring[0] }] });
    expect(closed.closure).toBe(0);

    const open = computePolygonArea({ mode: 'latlon', points: ring });
    // Closing edge is 0.001° of latitude ≈ 110.57 m.
    expect(open.closure).toBeCloseTo(110.57, 1);
  });

  it('validates latitude and longitude ranges', () => {
    expect(() =>
      computePolygonArea({
        mode: 'latlon',
        points: [
          { lat: 91, lon: 0 },
          { lat: 0, lon: 0 },
          { lat: 1, lon: 1 },
        ],
      }),
    ).toThrow(/latitude/);
    expect(() =>
      computePolygonArea({
        mode: 'latlon',
        points: [
          { lat: 0, lon: 181 },
          { lat: 0, lon: 0 },
          { lat: 1, lon: 1 },
        ],
      }),
    ).toThrow(/longitude/);
    expect(() => computePolygonArea({ mode: 'latlon', points: ring.slice(0, 2) })).toThrow(/at least 3/);
  });
});
