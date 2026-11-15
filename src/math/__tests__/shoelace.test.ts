import { describe, expect, it } from 'vitest';
import { centroid2D, perimeter2D, shoelaceArea, signedArea } from '../index';
import { toAreaUnits } from '../units';

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
    expect(() =>
      shoelaceArea([
        { x: 0, y: 0 },
        { x: 1, y: Number.NaN },
        { x: 2, y: 2 },
      ]),
    ).toThrow(/non-finite/);
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
