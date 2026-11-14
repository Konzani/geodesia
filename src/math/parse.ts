/**
 * Geodesia — client-side tabular ingestion
 * ---------------------------------------------------------------------------
 * CSV/TSV parsing (RFC 4180 tolerant: quotes, doubled quotes, embedded
 * newlines, CRLF and BOM), spreadsheet ingestion (xlsx, dynamically imported
 * only when a worksheet is actually opened) and heuristic mapping of arbitrary
 * survey headers onto terrain-profile roles.
 *
 * `ingestTerrainRows` never throws for a bad row — it records a warning and
 * keeps going. It throws only when the table has nothing usable at all
 * (no elevation column, no way to obtain distance).
 */
import type {
  LatLon,
  TabularData,
  TerrainColumnMap,
  TerrainColumnRole,
  TerrainIngestResult,
  TerrainSample,
} from './types';
import { geodesicInverse, parseDMS } from './geodesy';

/* ------------------------------------------------------------------------- */
/* Delimited text                                                            */
/* ------------------------------------------------------------------------- */

function stripByteOrderMark(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function countDelimiter(line: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') i += 1;
      else inQuotes = !inQuotes;
    } else if (char === delimiter && !inQuotes) {
      count += 1;
    }
  }
  return count;
}

/** Pick the most probable delimiter from a sample of the first lines. */
function detectDelimiter(text: string): string {
  const candidates = [',', '\t', ';', '|'];
  const lines = text
    .split(/\r\n|\n|\r/)
    .filter((line) => line.trim().length > 0)
    .slice(0, 10);
  let best = ',';
  let bestScore = 0;
  for (const candidate of candidates) {
    let score = 0;
    for (const line of lines) score += countDelimiter(line, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** RFC 4180 tolerant row splitter. */
function parseRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') {
      inQuotes = true;
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\r' || char === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      if (char === '\r' && text[i + 1] === '\n') i += 1;
    } else {
      field += char;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((parsed) => !(parsed.length === 1 && parsed[0].trim() === ''));
}

function uniqueHeaders(rawHeaders: string[]): string[] {
  const seen = new Map<string, number>();
  return rawHeaders.map((header, index) => {
    const trimmed = header.trim();
    const base = trimmed.length > 0 ? trimmed : `column_${index + 1}`;
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return count === 0 ? base : `${base}_${count + 1}`;
  });
}

function buildRecords(headers: string[], rows: string[][]): Array<Record<string, string | number>> {
  return rows.map((row) => {
    const record: Record<string, string | number> = {};
    headers.forEach((header, index) => {
      record[header] = row[index] ?? '';
    });
    return record;
  });
}

/** RFC 4180 tolerant CSV/TSV parser (quotes, CRLF, BOM). */
export function parseDelimitedText(text: string, delimiter?: string): TabularData {
  if (typeof text !== 'string') {
    throw new Error('parseDelimitedText expects the file contents as a string.');
  }
  const clean = stripByteOrderMark(text);
  if (clean.trim().length === 0) {
    throw new Error('The text contains no tabular data.');
  }
  if (delimiter !== undefined && (typeof delimiter !== 'string' || delimiter.length !== 1)) {
    throw new Error('delimiter must be a single character.');
  }
  const chosenDelimiter = delimiter ?? detectDelimiter(clean);
  const rows = parseRows(clean, chosenDelimiter);
  if (rows.length === 0) {
    throw new Error('The text contains no tabular data.');
  }

  const headerRow = rows[0].map((cell) => cell.trim());
  const width = Math.max(headerRow.length, ...rows.slice(1).map((row) => row.length));
  const paddedHeaders = [...headerRow, ...new Array<string>(Math.max(0, width - headerRow.length)).fill('')];
  const headers = uniqueHeaders(paddedHeaders);

  return {
    headers,
    rows: buildRecords(headers, rows.slice(1)),
    delimiter: chosenDelimiter,
  };
}

/* ------------------------------------------------------------------------- */
/* Spreadsheet ingestion                                                     */
/* ------------------------------------------------------------------------- */

interface XlsxModuleLike {
  read: (data: Uint8Array, options: { type: 'array' }) => {
    SheetNames: string[];
    Sheets: Record<string, unknown>;
  };
  utils: {
    sheet_to_json: (
      sheet: unknown,
      options: { header: 1; raw: true; defval: string },
    ) => unknown[][];
  };
}

function spreadsheetCellToValue(value: unknown): string | number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : '';
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Parse an .xlsx/.xls workbook's first sheet into the same shape (dynamic import of `xlsx`). */
export async function parseSpreadsheet(buffer: ArrayBuffer): Promise<TabularData> {
  if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
    throw new Error('A non-empty ArrayBuffer is required to read a spreadsheet.');
  }

  const imported = (await import('xlsx')) as unknown as { default?: XlsxModuleLike } & XlsxModuleLike;
  const xlsx = imported.default ?? imported;

  const workbook = xlsx.read(new Uint8Array(buffer), { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) {
    throw new Error('The spreadsheet has no worksheets.');
  }
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) {
    throw new Error(`Worksheet "${sheetName}" could not be read.`);
  }

  const matrix = xlsx.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
  const nonEmptyRows = matrix.filter(
    (row) =>
      Array.isArray(row) &&
      row.some((cell) => String(spreadsheetCellToValue(cell)).trim().length > 0),
  );
  if (nonEmptyRows.length === 0) {
    throw new Error('The spreadsheet contains no tabular data.');
  }

  const headerRow = nonEmptyRows[0].map((cell) => String(spreadsheetCellToValue(cell)).trim());
  const width = Math.max(
    headerRow.length,
    ...nonEmptyRows.slice(1).map((row) => (Array.isArray(row) ? row.length : 0)),
  );
  const paddedHeaders = [...headerRow, ...new Array<string>(Math.max(0, width - headerRow.length)).fill('')];
  const headers = uniqueHeaders(paddedHeaders);

  const rows: Array<Record<string, string | number>> = nonEmptyRows.slice(1).map((row) => {
    const record: Record<string, string | number> = {};
    headers.forEach((header, index) => {
      record[header] = spreadsheetCellToValue(row[index]);
    });
    return record;
  });

  return { headers, rows, delimiter: '\t' };
}

/* ------------------------------------------------------------------------- */
/* Terrain column detection                                                  */
/* ------------------------------------------------------------------------- */

const UNIT_TOKENS = new Set([
  'm',
  'km',
  'ft',
  'mi',
  'mm',
  'cm',
  'metre',
  'metres',
  'meter',
  'meters',
  'feet',
  'foot',
  'masl',
  'amsl',
  'deg',
  'degree',
  'degrees',
  'dd',
  'dms',
]);

function headerKey(header: string): string {
  const tokens = header
    .replace(/^\uFEFF/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean);
  while (tokens.length > 1 && UNIT_TOKENS.has(tokens[tokens.length - 1])) {
    tokens.pop();
  }
  return tokens.join(' ');
}

const ELEVATION_EXACT = new Set([
  'elevation',
  'elev',
  'elevation masl',
  'elev masl',
  'z',
  'height',
  'height m',
  'altitude',
  'alt',
  'level',
  'spot height',
  'orthometric height',
]);
const DISTANCE_EXACT = new Set([
  'chainage',
  'distance',
  'dist',
  'station',
  'chain',
  'stationing',
  'progressive',
  'offset',
  'along',
  'cumulative distance',
  'cum dist',
  'cumdist',
  'distance along line',
]);
const LAT_EXACT = new Set(['lat', 'latitude']);
const LON_EXACT = new Set(['lon', 'lng', 'long', 'longitude']);

function detectRole(header: string): TerrainColumnRole {
  const key = headerKey(header);
  if (key.length === 0) return 'unknown';
  if (ELEVATION_EXACT.has(key)) return 'elevation';
  if (DISTANCE_EXACT.has(key)) return 'distance';
  if (LAT_EXACT.has(key)) return 'lat';
  if (LON_EXACT.has(key)) return 'lon';

  // Substring fallbacks for decorated headers ("ground elevation (m)", "station_km").
  if (key.includes('elev') || key.includes('altitude')) return 'elevation';
  if (key.includes('chain') || key.includes('station')) return 'distance';
  if (key.includes('dist')) return 'distance';
  if (key.includes('lat')) return 'lat';
  if (key.includes('lon') || key.includes('lng')) return 'lon';
  return 'unknown';
}

/** Heuristically map arbitrary headers onto terrain roles. */
export function detectTerrainColumns(headers: string[]): TerrainColumnMap {
  if (!Array.isArray(headers)) {
    throw new Error('headers must be an array of column names.');
  }
  const mapping: TerrainColumnMap = { distance: null, elevation: null, lat: null, lon: null };
  for (const header of headers) {
    if (typeof header !== 'string') continue;
    const role = detectRole(header);
    if (role === 'elevation' && mapping.elevation === null) mapping.elevation = header;
    else if (role === 'distance' && mapping.distance === null) mapping.distance = header;
    else if (role === 'lat' && mapping.lat === null) mapping.lat = header;
    else if (role === 'lon' && mapping.lon === null) mapping.lon = header;
  }
  return mapping;
}

/* ------------------------------------------------------------------------- */
/* Terrain ingestion                                                         */
/* ------------------------------------------------------------------------- */

/** Parse a distance/elevation cell: plain numbers, thousands separators and
 *  simple unit suffixes ("123.4 m", "1,234.5") are accepted. */
function parseNumberCell(
  value: string | number | undefined,
  label: string,
  warnings: string[],
  rowNumber: number,
): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    warnings.push(`Row ${rowNumber}: ${label} is not a finite number; row skipped.`);
    return null;
  }
  if (typeof value !== 'string') {
    warnings.push(`Row ${rowNumber}: ${label} is missing; row skipped.`);
    return null;
  }

  let text = value.replace(/[\u00a0\u2007\u202f]/g, ' ').trim();
  if (text.length === 0) {
    warnings.push(`Row ${rowNumber}: ${label} is empty; row skipped.`);
    return null;
  }
  text = text.replace(/\s+/g, '').replace(/[a-zA-Z°'"]+$/, '');
  if (/^[-+]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) {
    text = text.replace(/,/g, '');
  } else if (text.includes(',') && !text.includes('.')) {
    if ((text.match(/,/g) ?? []).length === 1) text = text.replace(',', '.');
  }
  if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(text)) {
    warnings.push(`Row ${rowNumber}: could not read ${label} from "${value}"; row skipped.`);
    return null;
  }
  const parsed = Number(text);
  if (!Number.isFinite(parsed)) {
    warnings.push(`Row ${rowNumber}: ${label} is not a finite number; row skipped.`);
    return null;
  }
  return parsed;
}

/** Parse a latitude/longitude cell in decimal degrees or DMS. */
function parseAngleCell(
  value: string | number | undefined,
  label: string,
  warnings: string[],
  rowNumber: number,
): number | null {
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    warnings.push(`Row ${rowNumber}: ${label} is not a finite number; row skipped.`);
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    warnings.push(`Row ${rowNumber}: ${label} is missing; row skipped.`);
    return null;
  }
  const parsed = parseDMS(value);
  if (parsed === null) {
    warnings.push(`Row ${rowNumber}: could not read ${label} from "${value}"; row skipped.`);
    return null;
  }
  return parsed;
}

interface ParsedTerrainRow {
  elevation: number;
  lat: number | null;
  lon: number | null;
  distance: number | null;
  rowNumber: number;
}

/** Convert tabular rows into an elevation profile, geodesically accumulating
 *  distance when lat/lon columns are present. */
export function ingestTerrainRows(data: TabularData): TerrainIngestResult {
  if (!data || !Array.isArray(data.headers) || !Array.isArray(data.rows)) {
    throw new Error('ingestTerrainRows expects { headers, rows } tabular data.');
  }
  const mapping = detectTerrainColumns(data.headers);
  const warnings: string[] = [];

  if (mapping.elevation === null) {
    throw new Error(
      `No elevation column found. Available columns: ${data.headers.join(', ') || '(none)'}. ` +
        'Expected one of: elevation, elev, z, height, altitude.',
    );
  }

  const hasLat = mapping.lat !== null;
  const hasLon = mapping.lon !== null;
  const useGeodesic = hasLat && hasLon;
  const hasDistance = mapping.distance !== null;

  if (!useGeodesic && !hasDistance) {
    throw new Error(
      'No way to measure distance: add a chainage/distance column, or both latitude and longitude columns.',
    );
  }
  if (hasLat !== hasLon) {
    warnings.push('Only one coordinate column was detected; distances are taken from the distance column.');
  }
  if (useGeodesic && hasDistance) {
    warnings.push('Both a distance column and coordinates were found; distances are computed geodesically from the coordinates.');
  }

  const parsed: ParsedTerrainRow[] = [];
  data.rows.forEach((row, index) => {
    const rowNumber = index + 2; // row 1 is the header row
    const elevation = parseNumberCell(row[mapping.elevation as string], 'elevation', warnings, rowNumber);
    if (elevation === null) return;

    let lat: number | null = null;
    let lon: number | null = null;
    let distance: number | null = null;

    if (useGeodesic) {
      lat = parseAngleCell(row[mapping.lat as string], 'latitude', warnings, rowNumber);
      lon = parseAngleCell(row[mapping.lon as string], 'longitude', warnings, rowNumber);
      if (lat === null || lon === null) {
        warnings.push(`Row ${rowNumber}: incomplete coordinates; row skipped.`);
        return;
      }
      if (lat < -90 || lat > 90) {
        warnings.push(`Row ${rowNumber}: latitude ${lat} is outside -90..90; row skipped.`);
        return;
      }
      if (lon < -180 || lon > 180) {
        warnings.push(`Row ${rowNumber}: longitude ${lon} is outside -180..180; row skipped.`);
        return;
      }
    } else {
      distance = parseNumberCell(row[mapping.distance as string], 'distance', warnings, rowNumber);
      if (distance === null) return;
      if (distance < 0) {
        warnings.push(`Row ${rowNumber}: distance is negative; row skipped.`);
        return;
      }
    }

    parsed.push({ elevation, lat, lon, distance, rowNumber });
  });

  if (parsed.length === 0) {
    throw new Error(`No usable rows found. ${warnings[0] ?? 'Every row was missing required values.'}`);
  }

  let samples: TerrainSample[] = [];
  const trace: LatLon[] = [];

  if (useGeodesic) {
    let cumulative = 0;
    parsed.forEach((row, index) => {
      const point: LatLon = { lat: row.lat as number, lon: row.lon as number };
      if (index > 0) {
        cumulative += geodesicInverse({ lat: parsed[index - 1].lat as number, lon: parsed[index - 1].lon as number }, point).distance;
      }
      samples.push({ distance: cumulative, elevation: row.elevation, lat: point.lat, lon: point.lon });
      trace.push(point);
    });
  } else {
    const distances = parsed.map((row) => row.distance as number);
    const cumulativeMode = distances.every((value, index) => index === 0 || value >= distances[index - 1] - 1e-9);
    if (cumulativeMode) {
      samples = parsed.map((row) => ({ distance: row.distance as number, elevation: row.elevation }));
    } else {
      warnings.push('Distance values decrease between rows; they were interpreted as segment lengths and accumulated.');
      let running = 0;
      samples = parsed.map((row) => {
        running += row.distance as number;
        return { distance: running, elevation: row.elevation };
      });
    }
  }

  if (samples.length < 2) {
    warnings.push('Only one usable row was found; at least two rows (or samples) are needed to draw a profile.');
  }

  return {
    samples,
    mapping,
    source: useGeodesic ? 'lat/lon+elevation' : 'distance+elevation',
    warnings,
    trace,
  };
}

/** Convenience: sample an elevation profile along a geodesic line given an
 *  elevation provider (already-fetched elevations, in order). */
export function buildProfileFromPath(points: LatLon[], elevations: number[]): TerrainSample[] {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('At least one path point is required.');
  }
  if (!Array.isArray(elevations) || elevations.length !== points.length) {
    throw new Error(
      `Expected ${points.length} elevations but received ${Array.isArray(elevations) ? elevations.length : 0}.`,
    );
  }
  points.forEach((point, index) => {
    if (!point || typeof point !== 'object') {
      throw new Error(`Point ${index + 1} must be a { lat, lon } object.`);
    }
    if (typeof point.lat !== 'number' || !Number.isFinite(point.lat) || point.lat < -90 || point.lat > 90) {
      throw new Error(`Point ${index + 1} has an invalid latitude.`);
    }
    if (typeof point.lon !== 'number' || !Number.isFinite(point.lon) || point.lon < -180 || point.lon > 180) {
      throw new Error(`Point ${index + 1} has an invalid longitude.`);
    }
  });

  const samples: TerrainSample[] = [];
  let cumulative = 0;
  points.forEach((point, index) => {
    if (index > 0) {
      cumulative += geodesicInverse(points[index - 1], point).distance;
    }
    samples.push({
      distance: cumulative,
      elevation: typeof elevations[index] === 'number' ? elevations[index] : Number.NaN,
      lat: point.lat,
      lon: point.lon,
    });
  });
  return samples;
}
