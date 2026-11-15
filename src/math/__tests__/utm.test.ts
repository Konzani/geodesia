import { describe, expect, it } from 'vitest';
import {
  UTM_CONSTANTS,
  formatUtm,
  isUtmEngineLoaded,
  loadUtmEngine,
  lonLatToUtm,
  utmDefinition,
  utmToLonLat,
  utmZoneFromLonLat,
} from '../index';
import type { Hemisphere, LatLon, UtmParams } from '../index';

const ZONE_37_SOUTH: UtmParams = { zone: 37, hemisphere: 'S' };
const NAIROBI: LatLon = { lat: -1.2921, lon: 36.8219 };

/**
 * Fixed reference values measured during development against the previous
 * third-party projection library (version 2.23.0), which is no longer shipped.
 * They let this in-house Krüger implementation be checked against a previously
 * verified independent reference rather than only against itself.
 */
const REFERENCE_UTM: Array<{
  label: string;
  point: LatLon;
  params: UtmParams;
  E: number;
  N: number;
}> = [
  {
    label: 'Nairobi, zone 37S',
    point: { lat: -1.2921, lon: 36.8219 },
    params: { zone: 37, hemisphere: 'S' },
    E: 257634.50182633093,
    N: 9857079.966030994,
  },
  {
    label: 'zone 37S west of centre',
    point: { lat: -1.0, lon: 37.5 },
    params: { zone: 37, hemisphere: 'S' },
    E: 333093.62304304907,
    N: 9889431.704554291,
  },
  {
    label: 'zone 37N on the central meridian',
    point: { lat: 0.5, lon: 39.0 },
    params: { zone: 37, hemisphere: 'N' },
    E: 500000,
    N: 55265.037142649104,
  },
  {
    label: 'zone 37S east of centre',
    point: { lat: -0.5, lon: 41.5 },
    params: { zone: 37, hemisphere: 'S' },
    E: 778265.7782955498,
    N: 9944681.960023457,
  },
  {
    label: 'zone 30N near Greenwich',
    point: { lat: 51.4779, lon: -0.0015 },
    params: { zone: 30, hemisphere: 'N' },
    E: 708213.4949724032,
    N: 5707235.660472763,
  },
];

describe('UTM engine (built in, synchronous)', () => {
  it('is always ready and needs no chunk load', async () => {
    expect(isUtmEngineLoaded()).toBe(true);
    await loadUtmEngine();
    await loadUtmEngine();
    expect(isUtmEngineLoaded()).toBe(true);
    // Synchronous use, with no load step required.
    expect(lonLatToUtm(NAIROBI, ZONE_37_SOUTH).E).toBeCloseTo(257634.50182633093, 6);
  });

  it('publishes the WGS 84 / UTM constants', () => {
    expect(UTM_CONSTANTS.a).toBe(6378137);
    expect(UTM_CONSTANTS.e2).toBeCloseTo(0.0066943799901413165, 15);
    expect(UTM_CONSTANTS.k0).toBe(0.9996);
    expect(UTM_CONSTANTS.falseEasting).toBe(500000);
    expect(UTM_CONSTANTS.falseNorthingSouth).toBe(10000000);
  });
});

describe('utmDefinition', () => {
  it('returns a human-readable reference with the EPSG code', () => {
    expect(utmDefinition(37, 'S')).toBe('WGS 84 / UTM zone 37S (EPSG:32737)');
    expect(utmDefinition(37, 'N')).toBe('WGS 84 / UTM zone 37N (EPSG:32637)');
    expect(utmDefinition(1, 'N')).toBe('WGS 84 / UTM zone 1N (EPSG:32601)');
    expect(utmDefinition(60, 'S')).toBe('WGS 84 / UTM zone 60S (EPSG:32760)');
  });

  it('validates zone and hemisphere', () => {
    expect(() => utmDefinition(0, 'N')).toThrow(/zone/i);
    expect(() => utmDefinition(61, 'N')).toThrow(/zone/i);
    expect(() => utmDefinition(37.5, 'N')).toThrow(/zone/i);
    expect(() => utmDefinition(37, 'X' as Hemisphere)).toThrow(/hemisphere/i);
  });
});

describe('utmZoneFromLonLat', () => {
  it('derives the zone from longitude and the hemisphere from latitude', () => {
    expect(utmZoneFromLonLat(36.8219, -1.2921)).toEqual({ zone: 37, hemisphere: 'S' });
    expect(utmZoneFromLonLat(0, 0)).toEqual({ zone: 31, hemisphere: 'N' });
    expect(utmZoneFromLonLat(0, -0.0001)).toEqual({ zone: 31, hemisphere: 'S' });
    expect(utmZoneFromLonLat(-180, 10)).toEqual({ zone: 1, hemisphere: 'N' });
    expect(utmZoneFromLonLat(180, 10)).toEqual({ zone: 60, hemisphere: 'N' });
    expect(utmZoneFromLonLat(35.9999, 0).zone).toBe(36);
    expect(utmZoneFromLonLat(36, 0).zone).toBe(37);
    expect(() => utmZoneFromLonLat(200, 0)).toThrow(/longitude/i);
    expect(() => utmZoneFromLonLat(0, 91)).toThrow(/latitude/i);
  });
});

describe('UTM forward/inverse accuracy', () => {
  it('keeps the central-meridian invariant (E = 500 000 m ± 1e-6)', () => {
    const onCentralMeridian = lonLatToUtm({ lat: 0, lon: 39 }, { zone: 37, hemisphere: 'N' });
    expect(Math.abs(onCentralMeridian.E - 500000)).toBeLessThanOrEqual(1e-6);
    const atNairobiLatitude = lonLatToUtm({ lat: -1.2921, lon: 39 }, ZONE_37_SOUTH);
    expect(Math.abs(atNairobiLatitude.E - 500000)).toBeLessThanOrEqual(1e-6);
  });

  it('keeps the equator invariant (N = 0 north, N = 10 000 000 with +south)', () => {
    const north = lonLatToUtm({ lat: 0, lon: 39 }, { zone: 37, hemisphere: 'N' });
    expect(Math.abs(north.E - 500000)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(north.N - 0)).toBeLessThanOrEqual(1e-6);

    const south = lonLatToUtm({ lat: 0, lon: 39 }, ZONE_37_SOUTH);
    expect(Math.abs(south.E - 500000)).toBeLessThanOrEqual(1e-6);
    expect(Math.abs(south.N - 10000000)).toBeLessThanOrEqual(1e-6);
  });

  it('reproduces the verified Nairobi coordinate', () => {
    const projected = lonLatToUtm(NAIROBI, ZONE_37_SOUTH);
    expect(projected.E).toBeCloseTo(257634.50182633093, 6);
    expect(projected.N).toBeCloseTo(9857079.966030994, 6);
  });

  it('agrees with the fixed previously-verified reference values within 1e-6 m', () => {
    for (const reference of REFERENCE_UTM) {
      const projected = lonLatToUtm(reference.point, reference.params);
      expect(Math.abs(projected.E - reference.E)).toBeLessThan(1e-6);
      expect(Math.abs(projected.N - reference.N)).toBeLessThan(1e-6);
    }
  });

  it('round-trips lon/lat → UTM → lon/lat below 1e-9 degrees', () => {
    const cases: Array<{ point: LatLon; params: UtmParams }> = [
      { point: NAIROBI, params: ZONE_37_SOUTH },
      { point: { lat: -1.0, lon: 37.5 }, params: ZONE_37_SOUTH },
      { point: { lat: 0.5, lon: 39.0 }, params: { zone: 37, hemisphere: 'N' } },
      { point: { lat: -0.5, lon: 41.5 }, params: ZONE_37_SOUTH },
      { point: { lat: 51.4779, lon: -0.0015 }, params: { zone: 30, hemisphere: 'N' } },
      { point: { lat: 64.1, lon: -21.9 }, params: { zone: 28, hemisphere: 'N' } },
      { point: { lat: -33.9249, lon: 18.4241 }, params: { zone: 34, hemisphere: 'S' } },
    ];
    for (const { point, params } of cases) {
      const restored = utmToLonLat(lonLatToUtm(point, params), params);
      expect(Math.abs(restored.lat - point.lat)).toBeLessThan(1e-9);
      expect(Math.abs(restored.lon - point.lon)).toBeLessThan(1e-9);
    }
  });

  it('inverts the fixed reference coordinates below 1e-9 degrees', () => {
    for (const reference of REFERENCE_UTM) {
      const restored = utmToLonLat({ E: reference.E, N: reference.N }, reference.params);
      expect(Math.abs(restored.lat - reference.point.lat)).toBeLessThan(1e-9);
      expect(Math.abs(restored.lon - reference.point.lon)).toBeLessThan(1e-9);
    }
  });

  it('validates inputs and rejects non-finite UTM coordinates', () => {
    expect(() => lonLatToUtm({ lat: 91, lon: 0 }, ZONE_37_SOUTH)).toThrow(/latitude/i);
    expect(() => lonLatToUtm({ lat: 0, lon: 181 }, ZONE_37_SOUTH)).toThrow(/longitude/i);
    expect(() => lonLatToUtm({ lat: 90, lon: 0 }, ZONE_37_SOUTH)).toThrow(/poles/i);
    expect(() => utmToLonLat({ E: Number.NaN, N: 0 }, ZONE_37_SOUTH)).toThrow(/easting/i);
    expect(() => utmToLonLat({ E: 500000, N: Number.POSITIVE_INFINITY }, ZONE_37_SOUTH)).toThrow(/northing/i);
  });
});

describe('formatUtm', () => {
  it('formats easting/northing with millimetre precision', () => {
    const formatted = formatUtm({ E: 257634.50182633093, N: 9857079.966030994 });
    expect(formatted).toEqual({ E: '257634.502', N: '9857079.966' });
    expect(formatUtm({ E: 500000, N: 0 })).toEqual({ E: '500000.000', N: '0.000' });
    expect(() => formatUtm({ E: Number.NaN, N: 0 })).toThrow(/easting/i);
  });
});
