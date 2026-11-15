import { beforeAll, describe, expect, it } from 'vitest';
import {
  computePolygon,
  estimateCombinedScaleFactor,
  loadUtmEngine,
  lonLatToUtm,
  ringSelfIntersects,
  utmZoneFromLonLat,
  validatePolygonInput,
} from '../index';
import type { LatLon, UtmPoint, XYPoint } from '../index';

const SQUARE: XYPoint[] = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

/** ~111 m square just south of Nairobi (0.001° sides). */
const NAIROBI_PARCEL: LatLon[] = [
  { lat: -1.3, lon: 36.8 },
  { lat: -1.3, lon: 36.801 },
  { lat: -1.299, lon: 36.801 },
  { lat: -1.299, lon: 36.8 },
];

/** ~556 m square, still a "≤ 1 km parcel" for the scale-factor check. */
const LARGER_PARCEL: LatLon[] = [
  { lat: -1.3, lon: 36.8 },
  { lat: -1.3, lon: 36.805 },
  { lat: -1.295, lon: 36.805 },
  { lat: -1.295, lon: 36.8 },
];

const PARAMS = { zone: 37, hemisphere: 'S' } as const;

let parcelGrid: UtmPoint[] = [];

beforeAll(async () => {
  await loadUtmEngine();
  parcelGrid = NAIROBI_PARCEL.map((point) => lonLatToUtm(point, { zone: 37, hemisphere: 'S' }));
});

describe('computePolygon — local X/Y mode', () => {
  it('computes a grid-only 100 m square', async () => {
    const result = await computePolygon({ mode: 'xy', points: SQUARE });
    expect(result.mode).toBe('xy');
    expect(result.vertexCount).toBe(4);
    expect(result.grid.area).toBe(10000);
    expect(result.grid.perimeter).toBe(400);
    expect(result.geodesic).toBeNull();
    expect(result.ground).toBeNull();
    expect(result.zone).toBeNull();
    expect(result.hemisphere).toBeNull();
    expect(result.zoneAuto).toBe(false);
    expect(result.csf).toBeNull();
    expect(result.projectScaleFactor).toBeNull();
    expect(result.elevationFactor).toBeNull();
    expect(result.selfIntersecting).toBe(false);
    expect(result.units.m2).toBe(10000);
    expect(result.units.ha).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(result.centroid.grid).toEqual({ E: 50, N: 50 });
    expect(result.centroid.geo).toBeNull();
    expect(result.vertices[0]).toEqual({
      index: 0,
      input: { x: 0, y: 0 },
      grid: { E: 0, N: 0 },
      geo: null,
    });
    expect(result.legs).toHaveLength(4);
    expect(result.legs[0].gridDistance).toBe(100);
    expect(result.legs[0].gridBearing).toBeCloseTo(90, 9);
    expect(result.legs[1].gridBearing).toBeCloseTo(0, 9);
    expect(result.legs[2].gridBearing).toBeCloseTo(270, 9);
    expect(result.legs[3].gridBearing).toBeCloseTo(180, 9);
    expect(result.legs[0].geodesicDistance).toBeNull();
    expect(result.legs[0].geodesicAzimuth).toBeNull();
    expect(result.legs[0].groundDistance).toBeNull();
  });

  it('reports the closing leg, or 0 for an explicitly closed ring', async () => {
    const open = await computePolygon({ mode: 'xy', points: SQUARE });
    expect(open.closure).toBeCloseTo(100, 12);
    const closed = await computePolygon({ mode: 'xy', points: [...SQUARE, { ...SQUARE[0] }] });
    expect(closed.closure).toBe(0);
    expect(closed.vertexCount).toBe(4);
  });

  it('accepts a 3-vertex ring', async () => {
    const result = await computePolygon({
      mode: 'xy',
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 0, y: 100 },
      ],
    });
    expect(result.vertexCount).toBe(3);
    expect(result.grid.area).toBe(5000);
    expect(result.legs).toHaveLength(3);
    expect(result.closure).toBeCloseTo(100, 12);
  });

  it('warns when geodesic/ground surfaces are requested for local X/Y', async () => {
    const result = await computePolygon({ mode: 'xy', points: SQUARE }, { geodesic: true, ground: true });
    expect(result.geodesic).toBeNull();
    expect(result.ground).toBeNull();
    expect(result.warnings.join(' ')).toMatch(/Geodesic surface/);
    expect(result.warnings.join(' ')).toMatch(/Ground \(CSF\)/);
  });
});

describe('computePolygon — validation', () => {
  it('rejects duplicate consecutive vertices', async () => {
    const duplicate: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    expect(validatePolygonInput({ mode: 'xy', points: duplicate }).errors.join(' ')).toMatch(/Duplicate/);
    await expect(computePolygon({ mode: 'xy', points: duplicate })).rejects.toThrow(/Duplicate/);
  });

  it('rejects zero-area collinear rings', async () => {
    const collinear: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ];
    expect(validatePolygonInput({ mode: 'xy', points: collinear }).ok).toBe(false);
    await expect(computePolygon({ mode: 'xy', points: collinear })).rejects.toThrow(/zero\/invalid/i);
  });

  it('rejects fewer than three vertices', async () => {
    const twoPoints: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    await expect(computePolygon({ mode: 'xy', points: twoPoints })).rejects.toThrow(/at least 3/);
  });

  it('rejects invalid UTM zones and hemisphere values', async () => {
    await expect(
      computePolygon({ mode: 'utm', points: parcelGrid, zone: 70, hemisphere: 'S' }),
    ).rejects.toThrow(/zone/i);
    await expect(
      computePolygon({ mode: 'utm', points: parcelGrid, zone: 37, hemisphere: 'X' as 'S' }),
    ).rejects.toThrow(/hemisphere/i);
  });

  it('rejects out-of-range geographic coordinates', async () => {
    const bad: LatLon[] = [
      { lat: -1.3, lon: 36.8 },
      { lat: -1.3, lon: 36.801 },
      { lat: 91, lon: 36.801 },
    ];
    await expect(computePolygon({ mode: 'latlon', points: bad })).rejects.toThrow(/latitude/i);
  });
});

describe('computePolygon — self-intersection', () => {
  it('flags a bow-tie but still returns a finite area', async () => {
    const bowTie: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 20, y: 80 },
      { x: 80, y: 80 },
    ];
    expect(ringSelfIntersects(bowTie)).toBe(true);
    const result = await computePolygon({ mode: 'xy', points: bowTie });
    expect(result.selfIntersecting).toBe(true);
    expect(Number.isFinite(result.grid.area)).toBe(true);
    expect(result.grid.area).toBeCloseTo(1600, 9);
  });

  it('flags a symmetric bow-tie whose signed area is zero', async () => {
    const bowTie: XYPoint[] = [
      { x: 0, y: 0 },
      { x: 100, y: 100 },
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ];
    const result = await computePolygon({ mode: 'xy', points: bowTie });
    expect(result.selfIntersecting).toBe(true);
    expect(result.grid.area).toBe(0);
    expect(Number.isFinite(result.grid.area)).toBe(true);
  });

  it('does not flag a simple convex ring', async () => {
    const result = await computePolygon({ mode: 'xy', points: SQUARE });
    expect(result.selfIntersecting).toBe(false);
    expect(ringSelfIntersects(SQUARE)).toBe(false);
  });
});

describe('computePolygon — UTM mode', () => {
  it('builds grid, geodesic and vertex geography from E/N input', async () => {
    const result = await computePolygon({ mode: 'utm', points: parcelGrid, zone: 37, hemisphere: 'S' });
    expect(result.mode).toBe('utm');
    expect(result.zone).toBe(37);
    expect(result.hemisphere).toBe('S');
    expect(result.zoneAuto).toBe(false);
    expect(result.grid.area).toBeGreaterThan(0);
    expect(result.geodesic).not.toBeNull();
    expect(result.ground).toBeNull();
    expect(result.csf).toBeNull();
    expect(result.projectScaleFactor).not.toBeNull();
    expect(result.elevationFactor).toBeCloseTo(1, 12);
    expect(result.vertices).toHaveLength(4);
    expect(result.vertices.every((vertex) => vertex.geo !== null)).toBe(true);
    expect(result.vertices[0].input).toEqual({ x: parcelGrid[0].E, y: parcelGrid[0].N });
    expect(result.vertices[0].geo?.lat).toBeCloseTo(-1.3, 9);
    expect(result.vertices[0].geo?.lon).toBeCloseTo(36.8, 9);
    expect(result.legs[0].geodesicDistance).toBeCloseTo(111.29, 1);
    expect(result.legs[0].geodesicAzimuth).toBeCloseTo(90, 1);
    expect(result.units.ha).toBeCloseTo(result.grid.area / 10000, 10);
  });

  it('populates vertices[].geo even when both surfaces are disabled', async () => {
    const result = await computePolygon(
      { mode: 'utm', points: parcelGrid, zone: 37, hemisphere: 'S' },
      { geodesic: false, ground: false },
    );
    expect(result.geodesic).toBeNull();
    expect(result.ground).toBeNull();
    expect(result.vertices.every((vertex) => vertex.geo !== null)).toBe(true);
  });

  it('computes the ground surface from the combined scale factor', async () => {
    const result = await computePolygon(
      { mode: 'utm', points: parcelGrid, zone: 37, hemisphere: 'S' },
      { ground: true, meanElevationM: 1500 },
    );
    expect(result.ground).not.toBeNull();
    expect(result.csf).not.toBeNull();
    expect(result.projectScaleFactor).not.toBeNull();
    expect(result.elevationFactor).toBeCloseTo(6378137 / (6378137 + 1500), 12);
    // groundArea = gridArea / CSF² and groundPerimeter = gridPerimeter / CSF.
    expect(result.ground?.area).toBe(result.grid.area / ((result.csf as number) ** 2));
    expect(result.ground?.perimeter).toBe(result.grid.perimeter / (result.csf as number));
    expect(result.csf).toBeCloseTo((result.projectScaleFactor as number) * (result.elevationFactor as number), 12);
    expect(result.legs.every((leg) => leg.groundDistance !== null)).toBe(true);
    expect(result.legs[0].groundDistance).toBeCloseTo((result.legs[0].gridDistance as number) / (result.csf as number), 12);
  });

  it('computes the ground surface independently of the geodesic toggle', async () => {
    const result = await computePolygon(
      { mode: 'utm', points: parcelGrid, zone: 37, hemisphere: 'S' },
      { geodesic: false, ground: true, meanElevationM: 1500 },
    );
    expect(result.geodesic).toBeNull();
    expect(result.ground).not.toBeNull();
    expect(result.csf).not.toBeNull();
  });
});

describe('computePolygon — lat/lon mode', () => {
  it('derives the zone and hemisphere from the centroid', async () => {
    const expected = utmZoneFromLonLat(36.8005, -1.2995);
    const result = await computePolygon({ mode: 'latlon', points: NAIROBI_PARCEL });
    expect(result.zone).toBe(expected.zone);
    expect(result.hemisphere).toBe(expected.hemisphere);
    expect(result.zoneAuto).toBe(true);
    expect(result.grid.area).toBeGreaterThan(0);
    expect(result.geodesic).not.toBeNull();
    expect(result.vertices[0].geo).toEqual({ lat: -1.3, lon: 36.8 });
    expect(result.vertices[0].input).toEqual({ x: 36.8, y: -1.3 });
    expect(result.closure).toBeGreaterThan(100); // implicit closing leg ≈110.6 m
    expect(result.selfIntersecting).toBe(false);
  });

  it('honours an explicit zone/hemisphere and reports zoneAuto false', async () => {
    const result = await computePolygon({ mode: 'latlon', points: NAIROBI_PARCEL, zone: 37, hemisphere: 'S' });
    expect(result.zone).toBe(37);
    expect(result.hemisphere).toBe('S');
    expect(result.zoneAuto).toBe(false);
  });

  it('derives a missing half of an explicit zone/hemisphere pair and warns', async () => {
    const result = await computePolygon({ mode: 'latlon', points: NAIROBI_PARCEL, zone: 30 });
    expect(result.zone).toBe(30);
    expect(result.hemisphere).toBe('S');
    expect(result.zoneAuto).toBe(true);
    expect(result.warnings.join(' ')).toMatch(/together/);
  });

  it('returns closure 0 for an explicitly closed ring', async () => {
    const closed = [...NAIROBI_PARCEL, { ...NAIROBI_PARCEL[0] }];
    const result = await computePolygon({ mode: 'latlon', points: closed });
    expect(result.closure).toBe(0);
    expect(result.vertexCount).toBe(4);
  });

  it('keeps grid area consistent with geodesic area via the point scale factor k', async () => {
    const result = await computePolygon({ mode: 'latlon', points: LARGER_PARCEL });
    const scale = result.projectScaleFactor as number;
    expect(scale).toBeGreaterThan(0.9996);
    expect(scale).toBeLessThan(1.001);
    // Projection scale: grid = geodesic · k²  ⇔  grid/geodesic = k² (≤ 1e-4 relative).
    const ratio = result.grid.area / ((result.geodesic as { area: number }).area);
    expect(Math.abs(ratio - scale * scale) / (scale * scale)).toBeLessThan(1e-4);
    // Equivalent form: geodesic/grid = 1/k² (≤ 1e-4 relative).
    const inverseRatio = (result.geodesic as { area: number }).area / result.grid.area;
    expect(Math.abs(inverseRatio - 1 / (scale * scale)) / (1 / (scale * scale))).toBeLessThan(1e-4);
    expect(result.grid.area).toBeGreaterThan((result.geodesic as { area: number }).area);
  });

  it('holds the same scale relation on the central meridian (k < 1)', async () => {
    // 0.005° square centred on the zone-37 central meridian (lon 39°).
    const onCentralMeridian: LatLon[] = [
      { lat: -1.3, lon: 38.9975 },
      { lat: -1.3, lon: 39.0025 },
      { lat: -1.295, lon: 39.0025 },
      { lat: -1.295, lon: 38.9975 },
    ];
    const result = await computePolygon({ mode: 'latlon', points: onCentralMeridian });
    const scale = result.projectScaleFactor as number;
    // At the central meridian x = 0, so k = k0 = 0.9996 exactly.
    expect(scale).toBeCloseTo(0.9996, 12);
    expect(scale).toBeLessThan(1);
    const ratio = result.grid.area / ((result.geodesic as { area: number }).area);
    expect(Math.abs(ratio - scale * scale) / (scale * scale)).toBeLessThan(1e-4);
    expect(result.grid.area).toBeLessThan((result.geodesic as { area: number }).area);
  });
});

describe('estimateCombinedScaleFactor', () => {
  it('matches a hand-computed legacy CSF value', () => {
    const onCentralMeridian = estimateCombinedScaleFactor({
      points: [
        { E: 500000, N: 0 },
        { E: 500000, N: 1000 },
      ],
      centroid: { lat: -1.2921, lon: 36.8219 },
      meanElevationM: 1500,
      zone: 37,
    });
    expect(onCentralMeridian.projectScaleFactor).toBeCloseTo(0.9996, 12);
    expect(onCentralMeridian.elevationFactor).toBeCloseTo(0.9997648769044383, 12);
    expect(onCentralMeridian.csf).toBeCloseTo(0.9993649709536765, 12);

    const offCentre = estimateCombinedScaleFactor({
      points: [
        { E: 253000, N: 0 },
        { E: 255000, N: 1000 },
      ],
      centroid: { lat: -1.2921, lon: 36.8219 },
      meanElevationM: 1500,
      zone: 37,
    });
    expect(offCentre.projectScaleFactor).toBeCloseTo(1.000348501938971, 12);
    expect(offCentre.csf).toBeCloseTo(1.0001132969025546, 12);
  });

  it('uses a supplied CSF override but still reports the computed factors', () => {
    const result = estimateCombinedScaleFactor({
      points: [{ E: 254000, N: 0 }],
      centroid: { lat: -1.2921, lon: 36.8219 },
      meanElevationM: 1500,
      zone: 37,
      override: 1.02,
    });
    expect(result.csf).toBe(1.02);
    expect(result.projectScaleFactor).toBeCloseTo(1.000348501938971, 12);
    expect(result.elevationFactor).toBeCloseTo(0.9997648769044383, 12);
  });

  it('validates its arguments', () => {
    expect(() =>
      estimateCombinedScaleFactor({ points: [], centroid: { lat: 0, lon: 0 }, zone: 37 }),
    ).toThrow(/At least one grid point/);
    expect(() =>
      estimateCombinedScaleFactor({
        points: [{ E: 1, N: 2 }],
        centroid: { lat: 0, lon: 0 },
        zone: 0,
      }),
    ).toThrow(/zone/i);
    expect(() =>
      estimateCombinedScaleFactor({
        points: [{ E: 1, N: 2 }],
        centroid: { lat: 0, lon: 0 },
        zone: 37,
        override: Number.NaN,
      }),
    ).toThrow(/override/i);
  });
});

describe('validatePolygonInput — warnings', () => {
  it('suggests swapping columns when coordinates look like Lat,Lon', () => {
    const swappedSwapped: LatLon[] = [
      { lat: 36.8, lon: -1.3 },
      { lat: 36.81, lon: -1.29 },
      { lat: 36.82, lon: -1.28 },
    ];
    const validation = validatePolygonInput({ mode: 'latlon', points: swappedSwapped });
    expect(validation.ok).toBe(true);
    expect(validation.warnings.join(' ')).toMatch(/Lat,Lon/);
  });

  it('suggests swapping when the latitude column is beyond 90°', () => {
    const invalid: LatLon[] = [
      { lat: 120, lon: -1.3 },
      { lat: 36.81, lon: -1.29 },
      { lat: 36.82, lon: -1.28 },
    ];
    const validation = validatePolygonInput({ mode: 'latlon', points: invalid });
    expect(validation.ok).toBe(false);
    expect(validation.warnings.join(' ')).toMatch(/Lat,Lon/);
    expect(validation.errors.join(' ')).toMatch(/latitude/i);
  });
});
