import { describe, expect, it } from 'vitest';
import {
  TERRAIN_THRESHOLDS,
  classifySlope,
  computeTerrainProfile,
  type TerrainSample,
} from '../index';

/** Hand-computed profile: 0→100 m climb 10, 100→300 m drop 5, 300→400 m climb 15. */
const PROFILE: TerrainSample[] = [
  { distance: 0, elevation: 100 },
  { distance: 100, elevation: 110 },
  { distance: 300, elevation: 105 },
  { distance: 400, elevation: 120 },
];

describe('TERRAIN_THRESHOLDS / classifySlope', () => {
  it('exposes the ordered bounds', () => {
    expect(TERRAIN_THRESHOLDS).toEqual({ flat: 2, gentle: 5, rolling: 10, hilly: 20 });
  });

  it('classifies slope magnitudes at the boundaries', () => {
    expect(classifySlope(0)).toBe('Flat');
    expect(classifySlope(2)).toBe('Flat');
    expect(classifySlope(2.0001)).toBe('Gentle');
    expect(classifySlope(5)).toBe('Gentle');
    expect(classifySlope(5.1)).toBe('Rolling');
    expect(classifySlope(10)).toBe('Rolling');
    expect(classifySlope(10.1)).toBe('Hilly');
    expect(classifySlope(20)).toBe('Hilly');
    expect(classifySlope(20.1)).toBe('Steep');
    expect(classifySlope(120)).toBe('Steep');
  });

  it('rejects negative and non-finite slopes', () => {
    expect(() => classifySlope(-1)).toThrow(/greater than or equal to 0/);
    expect(() => classifySlope(Number.NaN)).toThrow(/finite/);
  });
});

describe('computeTerrainProfile', () => {
  it('matches a hand-computed profile', () => {
    const result = computeTerrainProfile(PROFILE);
    expect(result.samples).toHaveLength(4);
    expect(result.distance).toBe(400);
    expect(result.gain).toBeCloseTo(25, 12); // 10 + 15
    expect(result.descent).toBeCloseTo(5, 12);
    expect(result.net).toBeCloseTo(20, 12);
    expect(result.min).toBe(100);
    expect(result.max).toBe(120);
    expect(result.range).toBe(20);
    expect(result.startElevation).toBe(100);
    expect(result.endElevation).toBe(120);
    expect(result.meanElevation).toBeCloseTo(108.75, 12);
    expect(result.avgSlopePct).toBeCloseTo(6.25, 12); // 25 m climb / 400 m
    expect(result.segments).toHaveLength(3);

    expect(result.segments[0]).toMatchObject({ index: 0, from: 0, to: 100, run: 100, rise: 10 });
    expect(result.segments[0].slopePct).toBeCloseTo(10, 12);
    expect(result.segments[0].slopeDeg).toBeCloseTo(5.710593137, 6);
    expect(result.segments[1].slopePct).toBeCloseTo(-2.5, 12);
    expect(result.segments[2].slopePct).toBeCloseTo(15, 12);

    expect(result.maxSlopePct).toBeCloseTo(15, 12);
    expect(result.maxSlopeDeg).toBeCloseTo(8.53076561, 6);
    expect(result.maxSlopeAt).toBe(300);
    // 15 % maximum grade → Hilly under the exported thresholds.
    expect(result.category).toBe('Hilly');
  });

  it('ignores floating-point noise in gain and descent', () => {
    const result = computeTerrainProfile([
      { distance: 0, elevation: 100 },
      { distance: 50, elevation: 100 + 1e-12 },
      { distance: 100, elevation: 100 },
    ]);
    expect(result.gain).toBe(0);
    expect(result.descent).toBe(0);
    expect(result.net).toBeCloseTo(0, 12);
  });

  it('interpolates non-finite (no-data) elevations', () => {
    const result = computeTerrainProfile([
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: Number.NaN },
      { distance: 200, elevation: 120 },
    ]);
    expect(result.samples[1].elevation).toBeCloseTo(110, 12);
    expect(result.gain).toBeCloseTo(20, 12);
  });

  it('treats elevations below noDataBelow as holes and interpolates them', () => {
    const result = computeTerrainProfile(
      [
        { distance: 0, elevation: 100 },
        { distance: 100, elevation: -9999 },
        { distance: 200, elevation: 120 },
      ],
      { noDataBelow: 0 },
    );
    expect(result.samples[1].elevation).toBeCloseTo(110, 12);
    expect(result.gain).toBeCloseTo(20, 12);
  });

  it('applies an optional moving-average smoothing window', () => {
    const result = computeTerrainProfile(PROFILE, { smoothingWindow: 3 });
    // Edges shrink the window: [100,110]/2=105, [100,110,105]/3=105,
    // [110,105,120]/3=111.67, [105,120]/2=112.5.
    expect(result.samples.map((sample) => sample.elevation)).toEqual([105, 105, 111.66666666666667, 112.5]);
    expect(result.gain).toBeCloseTo(7.5, 9);
    expect(result.descent).toBeCloseTo(0, 9);
    expect(result.category).toBe('Gentle');
  });

  it('handles a flat run (run = 0) without Infinity or NaN', () => {
    const result = computeTerrainProfile([
      { distance: 0, elevation: 100 },
      { distance: 0, elevation: 100 },
      { distance: 100, elevation: 100 },
    ]);
    expect(result.segments[0].run).toBe(0);
    expect(result.segments[0].slopePct).toBe(0);
    expect(result.segments[0].slopeDeg).toBe(0);
    expect(result.maxSlopePct).toBe(0);
    expect(result.maxSlopeDeg).toBe(0);
    expect(result.category).toBe('Flat');
    expect(result.distance).toBe(100);
    for (const segment of result.segments) {
      expect(Number.isFinite(segment.slopePct)).toBe(true);
      expect(Number.isFinite(segment.slopeDeg)).toBe(true);
    }
  });

  it('supports chainages that do not start at zero', () => {
    const result = computeTerrainProfile([
      { distance: 1000, elevation: 100 },
      { distance: 1100, elevation: 110 },
    ]);
    expect(result.distance).toBe(100);
    expect(result.segments[0].from).toBe(1000);
    expect(result.maxSlopeAt).toBe(1000);
    expect(result.avgSlopePct).toBeCloseTo(10, 12);
  });

  it('carries optional coordinates through the processed samples', () => {
    const result = computeTerrainProfile([
      { distance: 0, elevation: 100, lat: -1.3, lon: 36.8 },
      { distance: 100, elevation: 110, lat: -1.3, lon: 36.801 },
    ]);
    expect(result.samples[0].lat).toBe(-1.3);
    expect(result.samples[1].lon).toBe(36.801);
  });

  it('validates the series', () => {
    expect(() => computeTerrainProfile([])).toThrow(/at least 2/);
    expect(() => computeTerrainProfile([{ distance: 0, elevation: 1 }])).toThrow(/at least 2/);
    expect(() =>
      computeTerrainProfile([
        { distance: 0, elevation: 100 },
        { distance: Number.NaN, elevation: 110 },
      ]),
    ).toThrow(/non-finite distance/);
    expect(() =>
      computeTerrainProfile([
        { distance: 0, elevation: 100 },
        { distance: 100, elevation: 110 },
        { distance: 50, elevation: 120 },
      ]),
    ).toThrow(/non-decreasing/);
    expect(() =>
      computeTerrainProfile(
        [
          { distance: 0, elevation: Number.NaN },
          { distance: 10, elevation: Number.NaN },
        ],
      ),
    ).toThrow(/No valid elevation/);
    expect(() =>
      computeTerrainProfile(PROFILE, { smoothingWindow: -1 }),
    ).toThrow(/smoothingWindow/);
  });
});
