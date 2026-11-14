import { describe, expect, it } from 'vitest';
import {
  buildProfileFromPath,
  computeTerrainProfile,
  detectTerrainColumns,
  geodesicInverse,
  ingestTerrainRows,
  parseDelimitedText,
  parseSpreadsheet,
} from '../index';

describe('parseDelimitedText', () => {
  it('parses quoted CSV with CRLF and a UTF-8 BOM', () => {
    const text =
      '\uFEFF"Point","Easting","Northing","Note"\r\n' +
      '"P1",0,0,"first, quoted"\r\n' +
      '"P2",100,0,"line one\r\nline two"\r\n';
    const data = parseDelimitedText(text);
    expect(data.delimiter).toBe(',');
    expect(data.headers).toEqual(['Point', 'Easting', 'Northing', 'Note']);
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].Note).toBe('first, quoted');
    expect(data.rows[1].Note).toBe('line one\r\nline two');
    expect(data.rows[0].Easting).toBe('0');
  });

  it('auto-detects tab and semicolon delimiters', () => {
    const tabbed = parseDelimitedText('chainage\televation\n0\t100\n100\t105\n');
    expect(tabbed.delimiter).toBe('\t');
    expect(tabbed.headers).toEqual(['chainage', 'elevation']);

    const semicolon = parseDelimitedText('chainage;elevation\n0;100\n');
    expect(semicolon.delimiter).toBe(';');
    expect(semicolon.rows[0].elevation).toBe('100');
  });

  it('honours an explicit delimiter even when it appears in headers', () => {
    const data = parseDelimitedText('a|b\n1|2', '|');
    expect(data.headers).toEqual(['a', 'b']);
    expect(data.rows[0].b).toBe('2');
  });

  it('ignores commas inside quoted header cells when detecting the delimiter', () => {
    const data = parseDelimitedText('"Distance, m",Elevation\n0,100\n');
    expect(data.delimiter).toBe(',');
    expect(data.headers).toEqual(['Distance, m', 'Elevation']);
    expect(data.rows[0]['Distance, m']).toBe('0');
  });

  it('uniquifies duplicate headers and pads short rows', () => {
    const data = parseDelimitedText('a,a,b\n1,2,3\n4,5');
    expect(data.headers).toEqual(['a', 'a_2', 'b']);
    expect(data.rows[0].a_2).toBe('2');
    expect(data.rows[1].b).toBe('');
  });

  it('handles doubled quotes and blank lines', () => {
    const data = parseDelimitedText('name,note\nP1,"say ""hi"""\n\nP2,ok\n');
    expect(data.rows).toHaveLength(2);
    expect(data.rows[0].note).toBe('say "hi"');
  });

  it('rejects empty input and invalid delimiters', () => {
    expect(() => parseDelimitedText('')).toThrow(/no tabular data/);
    expect(() => parseDelimitedText('   \r\n\r\n')).toThrow(/no tabular data/);
    expect(() => parseDelimitedText('a,b', '::')).toThrow(/single character/);
  });
});

describe('detectTerrainColumns', () => {
  it('detects common distance + elevation header sets', () => {
    expect(detectTerrainColumns(['Chainage (m)', 'Elevation (m)'])).toEqual({
      distance: 'Chainage (m)',
      elevation: 'Elevation (m)',
      lat: null,
      lon: null,
    });
    expect(detectTerrainColumns(['distance_m', 'elev_m'])).toEqual({
      distance: 'distance_m',
      elevation: 'elev_m',
      lat: null,
      lon: null,
    });
    expect(detectTerrainColumns(['Station', 'Height'])).toEqual({
      distance: 'Station',
      elevation: 'Height',
      lat: null,
      lon: null,
    });
    expect(detectTerrainColumns(['cumulative_distance', 'ground elevation (m)'])).toEqual({
      distance: 'cumulative_distance',
      elevation: 'ground elevation (m)',
      lat: null,
      lon: null,
    });
  });

  it('detects latitude/longitude + elevation header sets', () => {
    expect(detectTerrainColumns(['Latitude', 'Longitude', 'Elevation'])).toEqual({
      distance: null,
      elevation: 'Elevation',
      lat: 'Latitude',
      lon: 'Longitude',
    });
    expect(detectTerrainColumns(['lat', 'lon', 'z'])).toEqual({
      distance: null,
      elevation: 'z',
      lat: 'lat',
      lon: 'lon',
    });
    expect(detectTerrainColumns(['latitude_deg', 'longitude_deg', 'altitude'])).toEqual({
      distance: null,
      elevation: 'altitude',
      lat: 'latitude_deg',
      lon: 'longitude_deg',
    });
  });

  it('leaves unknown columns unmapped', () => {
    expect(detectTerrainColumns(['id', 'elevation'])).toEqual({
      distance: null,
      elevation: 'elevation',
      lat: null,
      lon: null,
    });
    expect(detectTerrainColumns(['notes', 'comment'])).toEqual({
      distance: null,
      elevation: null,
      lat: null,
      lon: null,
    });
  });
});

describe('ingestTerrainRows — distance + elevation', () => {
  it('builds a profile from a chainage column', () => {
    const data = parseDelimitedText('chainage,elevation\n0,100\n100,110\n250,100\n');
    const result = ingestTerrainRows(data);
    expect(result.source).toBe('distance+elevation');
    expect(result.mapping.distance).toBe('chainage');
    expect(result.mapping.elevation).toBe('elevation');
    expect(result.samples.map((sample) => sample.distance)).toEqual([0, 100, 250]);
    expect(result.samples.map((sample) => sample.elevation)).toEqual([100, 110, 100]);
    expect(result.warnings).toEqual([]);
    expect(result.trace).toEqual([]);

    const profile = computeTerrainProfile(result.samples);
    expect(profile.gain).toBeCloseTo(10, 9);
    expect(profile.descent).toBeCloseTo(10, 9);
  });

  it('warns instead of throwing for unusable rows', () => {
    const data = parseDelimitedText('chainage,elevation\n0,100\n50,n/a\n100,110\n150,\n');
    const result = ingestTerrainRows(data);
    expect(result.samples).toHaveLength(2);
    expect(result.warnings.length).toBeGreaterThanOrEqual(2);
    expect(result.warnings[0]).toMatch(/row 3/i);
  });

  it('accepts thousands separators and simple unit suffixes', () => {
    const data = parseDelimitedText('distance (m),elevation (m)\n"1,000",100\n"1,100",110\n');
    const result = ingestTerrainRows(data);
    expect(result.samples[0].distance).toBe(1000);
    expect(result.samples[1].distance).toBe(1100);
  });

  it('treats non-monotonic distances as segment lengths', () => {
    const data = parseDelimitedText('distance,elevation\n0,100\n10,110\n5,120\n');
    const result = ingestTerrainRows(data);
    expect(result.samples.map((sample) => sample.distance)).toEqual([0, 10, 15]);
    expect(result.warnings.join(' ')).toMatch(/segment lengths/);
  });

  it('supports a single usable row with a warning', () => {
    const data = parseDelimitedText('chainage,elevation\n0,100\n');
    const result = ingestTerrainRows(data);
    expect(result.samples).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/Only one usable row/);
  });

  it('ignores a lone latitude column when a distance column exists', () => {
    const data = parseDelimitedText('lat,distance,elevation\n-1.3,0,100\n-1.3,100,110\n');
    const result = ingestTerrainRows(data);
    expect(result.source).toBe('distance+elevation');
    expect(result.warnings.join(' ')).toMatch(/Only one coordinate column/);
    expect(result.samples[1].distance).toBe(100);
  });
});

describe('ingestTerrainRows — lat/lon + elevation', () => {
  it('accumulates geodesic distance from decimal-degree coordinates', () => {
    const data = parseDelimitedText(
      'latitude,longitude,elevation\n-1.3,36.8,100\n-1.3,36.801,110\n-1.299,36.801,120\n',
    );
    const result = ingestTerrainRows(data);
    expect(result.source).toBe('lat/lon+elevation');
    expect(result.trace).toHaveLength(3);
    expect(result.trace[0]).toEqual({ lat: -1.3, lon: 36.8 });
    expect(result.samples[0].distance).toBe(0);
    const expectedFirst = geodesicInverse({ lat: -1.3, lon: 36.8 }, { lat: -1.3, lon: 36.801 }).distance;
    expect(result.samples[1].distance).toBeCloseTo(expectedFirst, 9);
    expect(result.samples[1].lat).toBe(-1.3);
    expect(result.samples[1].lon).toBe(36.801);
    expect(result.samples[0].elevation).toBe(100);
  });

  it('parses DMS latitude/longitude cells', () => {
    const data = parseDelimitedText(
      'Latitude,Longitude,Elevation\n' +
        '1°23′45.6″S,36°49′18.8″E,100\n' +
        '1°23′46.6″S,36°49′19.8″E,110\n',
    );
    const result = ingestTerrainRows(data);
    expect(result.warnings).toEqual([]);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0].lat).toBeCloseTo(-(1 + 23 / 60 + 45.6 / 3600), 9);
    expect(result.samples[0].lon).toBeCloseTo(36 + 49 / 60 + 18.8 / 3600, 9);
    expect(result.samples[1].distance).toBeGreaterThan(0);
  });

  it('prefers geodesic distances when both distance and coordinates exist', () => {
    const data = parseDelimitedText(
      'distance,lat,lon,elevation\n0,-1.3,36.8,100\n10,-1.3,36.801,110\n',
    );
    const result = ingestTerrainRows(data);
    expect(result.source).toBe('lat/lon+elevation');
    expect(result.warnings.join(' ')).toMatch(/computed geodesically/);
    expect(result.samples[1].distance).toBeGreaterThan(100); // ~111 m, not the 10 m hint
  });

  it('skips out-of-range coordinates with warnings', () => {
    const data = parseDelimitedText('lat,lon,elevation\n91,36.8,100\n-1.3,36.8,110\n');
    const result = ingestTerrainRows(data);
    expect(result.samples).toHaveLength(1);
    expect(result.warnings.join(' ')).toMatch(/outside -90\.\.90/);
  });
});

describe('ingestTerrainRows — hard failures', () => {
  it('throws when no elevation column exists', () => {
    const data = parseDelimitedText('easting,northing\n1,2\n');
    expect(() => ingestTerrainRows(data)).toThrow(/No elevation column/);
  });

  it('throws when there is no way to obtain distance', () => {
    const data = parseDelimitedText('elevation,note\n100,a\n110,b\n');
    expect(() => ingestTerrainRows(data)).toThrow(/No way to measure distance/);
  });

  it('throws when every row is unusable', () => {
    const data = parseDelimitedText('chainage,elevation\n0,n/a\n100,also-bad\n');
    expect(() => ingestTerrainRows(data)).toThrow(/No usable rows/);
  });
});

describe('buildProfileFromPath', () => {
  const path = [
    { lat: 0, lon: 0 },
    { lat: 0, lon: 0.001 },
    { lat: 0, lon: 0.002 },
  ];

  it('converts a geodesic path and elevation array into samples', () => {
    const samples = buildProfileFromPath(path, [100, 110, Number.NaN]);
    expect(samples).toHaveLength(3);
    expect(samples[0].distance).toBe(0);
    const firstLeg = geodesicInverse(path[0], path[1]).distance;
    expect(samples[1].distance).toBeCloseTo(firstLeg, 9);
    expect(samples[2].distance).toBeCloseTo(firstLeg + geodesicInverse(path[1], path[2]).distance, 6);
    expect(samples[1].lat).toBe(0);
    expect(samples[1].lon).toBe(0.001);
    expect(Number.isNaN(samples[2].elevation)).toBe(true);
    // NaN elevations are interpolated by the profile statistics.
    const profile = computeTerrainProfile(samples);
    expect(profile.gain).toBeCloseTo(10, 6);
  });

  it('validates its inputs', () => {
    expect(() => buildProfileFromPath([], [])).toThrow(/At least one/);
    expect(() => buildProfileFromPath(path, [1, 2])).toThrow(/Expected 3/);
    expect(() => buildProfileFromPath([{ lat: 95, lon: 0 }], [1])).toThrow(/invalid latitude/);
  });
});

interface XlsxUtilsLike {
  book_new: () => unknown;
  aoa_to_sheet: (rows: Array<Array<string | number>>) => unknown;
  book_append_sheet: (workbook: unknown, sheet: unknown, name: string) => void;
}

interface XlsxLike {
  utils: XlsxUtilsLike;
  write: (workbook: unknown, options: { type: 'array'; bookType: 'xlsx' }) => unknown;
}

async function buildWorkbookBuffer(rows: Array<Array<string | number>>): Promise<ArrayBuffer> {
  const imported = (await import('xlsx')) as unknown as { default?: XlsxLike } & XlsxLike;
  const xlsx = imported.default ?? imported;
  const sheet = xlsx.utils.aoa_to_sheet(rows);
  const workbook = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(workbook, sheet, 'Profile');
  const written = xlsx.write(workbook, { type: 'array', bookType: 'xlsx' });
  if (written instanceof ArrayBuffer) return written;
  if (ArrayBuffer.isView(written)) {
    const view = written as ArrayBufferView;
    return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
  }
  throw new Error('Unexpected workbook output type.');
}

describe('parseSpreadsheet', () => {
  // Generating an .xlsx fixture with the xlsx writer can be slow on a loaded
  // CI box; the parser itself is fast once the buffer exists.
  it(
    'reads the first worksheet into the tabular shape',
    async () => {
      const buffer = await buildWorkbookBuffer([
        ['chainage', 'elevation'],
        [0, 100],
        [100, 110],
        [200, 105],
      ]);
      const data = await parseSpreadsheet(buffer);
      expect(data.headers).toEqual(['chainage', 'elevation']);
      expect(data.rows).toHaveLength(3);
      expect(data.rows[1].elevation).toBe(110);

      const ingested = ingestTerrainRows(data);
      expect(ingested.source).toBe('distance+elevation');
      expect(ingested.samples.map((sample) => sample.distance)).toEqual([0, 100, 200]);
    },
    30_000,
  );

  it('rejects an empty buffer', async () => {
    await expect(parseSpreadsheet(new ArrayBuffer(0))).rejects.toThrow(/non-empty ArrayBuffer/);
  });
});
