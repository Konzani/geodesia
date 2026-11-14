import { describe, expect, it } from 'vitest';
import {
  WGS84,
  formatDD,
  formatDMS,
  geodesicDirect,
  geodesicInverse,
  geodesicPath,
  geodesicPolylinePath,
  geodesicPolygonArea,
  parseDMS,
} from '../index';

describe('WGS 84 constants', () => {
  it('matches the published ellipsoid parameters', () => {
    expect(WGS84.a).toBe(6378137);
    expect(WGS84.f).toBeCloseTo(1 / 298.257223563, 12);
    expect(WGS84.b).toBeCloseTo(6356752.314245179, 6);
    expect(WGS84.e2).toBeCloseTo(0.0066943799901413165, 15);
    // Published authalic radius of WGS 84.
    expect(WGS84.authalicRadius).toBeCloseTo(6371007.180918474, 6);
  });
});

describe('parseDMS', () => {
  const oneDegree = 1 + 23 / 60 + 45.6 / 3600;
  const longOne = 36 + 49 / 60 + 18.8 / 3600;

  it('parses degree/minute/second forms with ASCII and unicode primes', () => {
    expect(parseDMS('1°23\'45.6"S')).toBeCloseTo(-oneDegree, 12);
    expect(parseDMS('1°23′45.6″S')).toBeCloseTo(-oneDegree, 12);
    expect(parseDMS('1 23 45.6 S')).toBeCloseTo(-oneDegree, 12);
    expect(parseDMS('1 23 45.6S')).toBeCloseTo(-oneDegree, 12);
    expect(parseDMS('S 1 23 45.6')).toBeCloseTo(-oneDegree, 12);
    expect(parseDMS('36°49\'18.8"E')).toBeCloseTo(longOne, 12);
    expect(parseDMS('36°49′18.8″E')).toBeCloseTo(longOne, 12);
  });

  it('parses decimal degrees with signs, hemisphere suffixes and spaces', () => {
    expect(parseDMS('-1.396')).toBeCloseTo(-1.396, 12);
    expect(parseDMS('+1.396')).toBeCloseTo(1.396, 12);
    expect(parseDMS(' 36.8 ')).toBeCloseTo(36.8, 12);
    expect(parseDMS('36.8E')).toBeCloseTo(36.8, 12);
    expect(parseDMS('36.8 W')).toBeCloseTo(-36.8, 12);
    expect(parseDMS('1.396S')).toBeCloseTo(-1.396, 12);
    expect(parseDMS('0')).toBe(0);
  });

  it('accepts decimal minutes and colon separators', () => {
    expect(parseDMS('1°23.5\'S')).toBeCloseTo(-(1 + 23.5 / 60), 12);
    expect(parseDMS('1:23:45.6 S')).toBeCloseTo(-oneDegree, 12);
  });

  it('returns null for invalid or out-of-range input', () => {
    expect(parseDMS('')).toBeNull();
    expect(parseDMS('   ')).toBeNull();
    expect(parseDMS('abc')).toBeNull();
    expect(parseDMS('1 2 3 4')).toBeNull();
    expect(parseDMS('1°60\'00"')).toBeNull();
    expect(parseDMS('1°00\'60"')).toBeNull();
    expect(parseDMS('181')).toBeNull();
    expect(parseDMS('1.5e-3')).toBeNull();
    expect(parseDMS('12 metres')).toBeNull();
  });
});

describe('formatDMS / formatDD', () => {
  it('formats DMS with unicode primes and the right hemisphere', () => {
    expect(formatDMS(-1.396, 1)).toBe('1°23′45.6″S');
    expect(formatDMS(1.396, 1, 'lat')).toBe('1°23′45.6″N');
    expect(formatDMS(36.8218888889, 1, 'lon')).toBe('36°49′18.8″E');
    expect(formatDMS(-36.8218888889, 1, 'lon')).toBe('36°49′18.8″W');
    expect(formatDMS(10.5, 0)).toBe('10°30′00″N');
  });

  it('infers longitude hemispheres for magnitudes beyond 90 degrees', () => {
    expect(formatDMS(-179.5, 1)).toBe('179°30′00.0″W');
    expect(formatDMS(120, 0)).toContain('E');
    expect(formatDD(-1.2921, 4, 'lat')).toBe('1.2921°S');
    expect(formatDD(36.8218888889, 4, 'lon')).toBe('36.8219°E');
    expect(formatDD(0, 3, 'lat')).toBe('0.000°N');
  });

  it('round-trips DMS for latitudes and longitudes', () => {
    const latitudes = [0, 1.396, -1.396, -1.2921, 51.4779, 89.999];
    for (const latitude of latitudes) {
      const parsedLatitude = parseDMS(formatDMS(latitude, 6, 'lat'));
      expect(parsedLatitude).not.toBeNull();
      expect(parsedLatitude as number).toBeCloseTo(latitude, 7);
    }
    const longitudes = [0, 36.8218888889, -36.8218888889, 179.9, -179.9, 120.25];
    for (const longitude of longitudes) {
      const parsedLongitude = parseDMS(formatDMS(longitude, 6, 'lon'));
      expect(parsedLongitude).not.toBeNull();
      expect(parsedLongitude as number).toBeCloseTo(longitude, 7);
    }
  });

  it('rejects invalid decimals and non-finite degrees', () => {
    expect(() => formatDMS(Number.NaN)).toThrow(/finite/);
    expect(() => formatDMS(1, -1)).toThrow(/decimals/);
    expect(() => formatDMS(1, 1.5)).toThrow(/decimals/);
  });
});

describe('geodesic inverse / direct', () => {
  it('measures the classic one-degree references on WGS 84', () => {
    const alongEquator = geodesicInverse({ lat: 0, lon: 0 }, { lat: 0, lon: 1 });
    expect(alongEquator.distance).toBeCloseTo(111319.49079327357, 5);
    expect(alongEquator.azi1).toBeCloseTo(90, 9);

    const alongMeridian = geodesicInverse({ lat: 0, lon: 0 }, { lat: 1, lon: 0 });
    expect(alongMeridian.distance).toBeCloseTo(110574.38855779878, 5);
    expect(alongMeridian.azi1).toBeCloseTo(0, 9);

    const coincident = geodesicInverse({ lat: 1, lon: 36 }, { lat: 1, lon: 36 });
    expect(coincident.distance).toBe(0);
  });

  it('normalises azimuths into [0, 360)', () => {
    const result = geodesicInverse({ lat: 0, lon: 0 }, { lat: 0, lon: -1 });
    expect(result.azi1).toBeGreaterThanOrEqual(0);
    expect(result.azi1).toBeLessThan(360);
    expect(result.azi1).toBeCloseTo(270, 9);
  });

  it('round-trips direct and inverse', () => {
    const start = { lat: 0, lon: 36 };
    const end = geodesicDirect(start, 45, 123456.789);
    const inverse = geodesicInverse(start, end);
    expect(inverse.distance).toBeCloseTo(123456.789, 6);
    expect(inverse.azi1).toBeCloseTo(45, 9);

    const north = geodesicDirect({ lat: 0, lon: 0 }, 0, 110574.38855779878);
    expect(north.lat).toBeCloseTo(1, 10);
    expect(north.lon).toBeCloseTo(0, 10);
  });

  it('validates coordinates and distance', () => {
    expect(() => geodesicInverse({ lat: 91, lon: 0 }, { lat: 0, lon: 0 })).toThrow(/between -90 and 90/);
    expect(() => geodesicInverse({ lat: 0, lon: 181 }, { lat: 0, lon: 0 })).toThrow(/between -180 and 180/);
    expect(() => geodesicDirect({ lat: 0, lon: 0 }, 0, -1)).toThrow(/greater than or equal to 0/);
  });
});

describe('geodesicPath', () => {
  const start = { lat: -1.2921, lon: 36.8219 };
  const end = { lat: -1.3921, lon: 36.9219 };

  it('includes exact endpoints and honours the interval floor', () => {
    const path = geodesicPath(start, end, 500, 50);
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(end);
    const total = geodesicInverse(start, end).distance;
    expect(path.length).toBe(Math.floor(total / 50) + 1);
    for (let i = 1; i < path.length; i += 1) {
      expect(geodesicInverse(path[i - 1], path[i]).distance).toBeGreaterThanOrEqual(50 - 1e-6);
    }
  });

  it('caps the sample count and still lands exactly on the end point', () => {
    const far = { lat: -0.2921, lon: 37.8219 };
    const path = geodesicPath(start, far, 500, 50);
    expect(path.length).toBe(500);
    expect(path[0]).toEqual(start);
    expect(path[path.length - 1]).toEqual(far);
  });

  it('uses the interval floor (never samples denser than requested)', () => {
    const target = geodesicDirect(start, 90, 120);
    const path = geodesicPath(start, target, 500, 50);
    expect(path.length).toBe(3);
  });

  it('handles a zero-length path and validates options', () => {
    expect(geodesicPath(start, start)).toHaveLength(2);
    expect(() => geodesicPath(start, end, 1, 50)).toThrow(/maxSamples/);
    expect(() => geodesicPath(start, end, 10, 0)).toThrow(/intervalM/);
  });
});

describe('geodesicPolylinePath', () => {
  const first = { lat: 0, lon: 0 };
  const middle = { lat: 0, lon: 0.001 };
  const last = { lat: 0.001, lon: 0.001 };

  it('preserves vertices and accumulates distance', () => {
    const result = geodesicPolylinePath([first, middle, last], 500, 50);
    expect(result.points[0]).toEqual(first);
    expect(result.points[result.points.length - 1]).toEqual(last);
    expect(result.points.some((point) => point.lat === middle.lat && point.lon === middle.lon)).toBe(true);
    expect(result.cumulative).toHaveLength(result.points.length);
    expect(result.cumulative[0]).toBe(0);
    expect(result.cumulative[result.cumulative.length - 1]).toBeCloseTo(result.totalDistance, 9);
    const expected =
      geodesicInverse(first, middle).distance + geodesicInverse(middle, last).distance;
    expect(result.totalDistance).toBeCloseTo(expected, 9);
    for (let i = 1; i < result.cumulative.length; i += 1) {
      expect(result.cumulative[i]).toBeGreaterThanOrEqual(result.cumulative[i - 1] - 1e-9);
    }
  });

  it('keeps every vertex when maxSamples is smaller than the vertex count', () => {
    const points = [
      { lat: 0, lon: 0 },
      { lat: 0, lon: 0.0002 },
      { lat: 0.0002, lon: 0.0004 },
      { lat: 0.0004, lon: 0.0006 },
      { lat: 0.0006, lon: 0.0008 },
    ];
    const result = geodesicPolylinePath(points, 3, 500);
    expect(result.points).toHaveLength(points.length);
  });

  it('handles a zero-length polyline and short inputs', () => {
    const result = geodesicPolylinePath([first, { ...first }], 500, 50);
    expect(result.totalDistance).toBe(0);
    expect(() => geodesicPolylinePath([first], 500, 50)).toThrow(/at least 2/);
  });
});

describe('geodesicPolygonArea', () => {
  // Karney/GeographicLib reference: 1° x 1° cell at the equator, WGS 84.
  // Cross-checked against the independent closed-form integral over the
  // ellipsoid patch (M·N·cosφ dφ dλ), which gives 12 308 463 893.975 m²
  // for a latitude/longitude rectangle (the geodesic polygon's bulging
  // east/west edges make it 0.0026 % larger).
  const GEODESIC_CELL_AREA = 12308778361.469452;
  const RECTANGLE_INTEGRAL_AREA = 12308463893.975351;
  const CELL_PERIMETER = 443770.91724830196;
  const ring = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 1 },
    { lat: 1, lon: 1 },
    { lat: 1, lon: 0 },
  ];

  it('matches the GeographicLib reference area within 0.1 %', () => {
    const result = geodesicPolygonArea(ring);
    expect(Math.abs(result.area - GEODESIC_CELL_AREA) / GEODESIC_CELL_AREA).toBeLessThan(0.001);
    // Independent order-of-magnitude check against the ellipsoid integral.
    expect(Math.abs(result.area - RECTANGLE_INTEGRAL_AREA) / RECTANGLE_INTEGRAL_AREA).toBeLessThan(0.001);
    expect(Math.abs(result.perimeter - CELL_PERIMETER) / CELL_PERIMETER).toBeLessThan(0.001);
  });

  it('is orientation independent and accepts an explicit closing vertex', () => {
    const reversed = [...ring].reverse();
    const closed = [...ring, { ...ring[0] }];
    const forwardArea = geodesicPolygonArea(ring).area;
    expect(geodesicPolygonArea(reversed).area).toBeCloseTo(forwardArea, 3);
    expect(geodesicPolygonArea(closed).area).toBeCloseTo(forwardArea, 3);
  });

  it('validates the ring', () => {
    expect(() => geodesicPolygonArea([ring[0], ring[1]])).toThrow(/at least 3/);
    expect(() => geodesicPolygonArea([{ lat: 95, lon: 0 }, ring[1], ring[2]])).toThrow(/between -90 and 90/);
  });
});
