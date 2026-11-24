/**
 * GEODESIA â€” Polygon Area instrument (legacy methodology, v2 contract).
 *
 * Three reference systems: local X/Y (grid only), UTM E/N (grid + geodesic +
 * ground) and WGS 84 lon/lat (auto-projected grid + geodesic + ground). The
 * maths all lives behind `src/math` (`computePolygon` with the lazy projection
 * engine); this component only parses input, drives the white coordinate-sheet
 * plot and the map, and renders/exports the three surfaces.
 *
 * Legacy behaviour deliberately restored: lon,lat column order with swap
 * detection, explicit Compute action, grid/geodesic/ground result cards, a
 * per-leg vector table, and a white graph plotting surface for grid work.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { LatLon, TabularData } from '../../math/types';
import type {
  Hemisphere,
  PolygonInput,
  PolygonMode,
  PolygonResult,
  UtmPoint,
} from '../../math/polygon-types';
import {
  computePolygon,
  convertArea,
  fmtNumber,
  formatDD,
  formatDMS,
  isUtmEngineLoaded,
  loadUtmEngine,
  parseDMS,
  parseDelimitedText,
  parseSpreadsheet,
  utmToLonLat,
  utmZoneFromLonLat,
  validatePolygonInput,
} from '../../math';
import { buildVerification, exportCSV, exportFilename, exportJSON, exportPDF, timestamp } from '../../exports';
import type { PdfReportSpec } from '../../exports/types';
import {
  DataTable,
  EmptyState,
  Field,
  Notice,
  Panel,
  Readout,
  ReadoutGrid,
  Segmented,
  Toolbar,
} from '../components/ui';
import type { DataTableColumn } from '../components/ui';
import { MapCanvas } from './MapCanvas';
import type { BasemapChange, MapCanvasApi, MapMarker } from './MapCanvas';
import { MAP_DEFAULT_VIEW } from './basemap';
import { PlotSurface } from './PlotSurface';
import { IconArrowDown, IconArrowUp, IconCrosshair, IconDownload, IconGrid, IconPlus, IconPolygon, IconTrash, IconUpload } from './icons';
import { errorMessage, readFileAsArrayBuffer, readFileAsText } from './utils';

interface VertexRow {
  id: string;
  a: string;
  b: string;
}

interface ParsedPoint {
  a: number;
  b: number;
}

interface ParsedState {
  points: ParsedPoint[];
  invalidRows: number[];
  swapSuspected: 'strong' | 'weak' | null;
}

interface LegRow {
  key: string;
  leg: string;
  from: string;
  to: string;
  grid: string;
  geodesic: string;
  ground: string;
  gridBearing: string;
  azimuth: string;
}

type ExportKind = 'csv' | 'json' | 'pdf';

const modeOptions: ReadonlyArray<{ value: PolygonMode; label: string }> = [
  { value: 'xy', label: 'Local X/Y' },
  { value: 'utm', label: 'UTM' },
  { value: 'latlon', label: 'Geographic' },
];

const HEMISPHERES: ReadonlyArray<{ value: Hemisphere; label: string }> = [
  { value: 'N', label: 'North' },
  { value: 'S', label: 'South' },
];

const SAMPLES: Record<PolygonMode, ReadonlyArray<readonly [string, string]>> = {
  xy: [
    ['0', '0'],
    ['120', '0'],
    ['120', '80'],
    ['45', '110'],
    ['0', '80'],
  ],
  utm: [
    ['253000', '9858000'],
    ['253120', '9858000'],
    ['253120', '9858080'],
    ['253045', '9858110'],
    ['253000', '9858080'],
  ],
  latlon: [
    ['36.817200', '-1.286400'],
    ['36.818900', '-1.286400'],
    ['36.818900', '-1.287600'],
    ['36.817200', '-1.287600'],
  ],
};

const MODE_HINTS: Record<PolygonMode, string> = {
  latlon: 'Click the map to add corners â€” the simplest way for most parcels. The UTM zone is derived from the centroid automatically.',
  utm: 'Enter E, N grid coordinates in metres plus the zone and hemisphere. The map is a spatial check; grid results are planar.',
  xy: 'Local X/Y in metres with an arbitrary origin. Plan area and perimeter only â€” no map, no geographic reference.',
};

function parseNumeric(value: string): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const numeric = Number(trimmed.replace(/,/g, ''));
  return Number.isFinite(numeric) ? numeric : null;
}

function parseVertexValue(value: string, mode: PolygonMode): number | null {
  if (mode === 'latlon') {
    const dms = parseDMS(value.trim());
    return dms !== null && Number.isFinite(dms) ? dms : null;
  }
  return parseNumeric(value);
}

function parseRows(rows: ReadonlyArray<VertexRow>, mode: PolygonMode): ParsedState {
  const points: ParsedPoint[] = [];
  const invalidRows: number[] = [];
  rows.forEach((row, index) => {
    const a = parseVertexValue(row.a, mode);
    const b = parseVertexValue(row.b, mode);
    if (mode === 'latlon') {
      if (a === null || b === null || Math.abs(a) > 180 || Math.abs(b) > 90) {
        invalidRows.push(index);
        return;
      }
      points.push({ a, b });
      return;
    }
    if (a === null || b === null) {
      invalidRows.push(index);
      return;
    }
    points.push({ a, b });
  });

  let swapSuspected: 'strong' | 'weak' | null = null;
  if (mode === 'latlon' && points.length > 0) {
    const allFirstWithin90 = points.every((point) => Math.abs(point.a) <= 90);
    const anySecondBeyond90 = points.some((point) => Math.abs(point.b) > 90);
    const allSecondLookLikeLon = points.every(
      (point) => Math.abs(point.b) >= 20 && Math.abs(point.b) <= 60,
    );
    if (allFirstWithin90 && anySecondBeyond90) swapSuspected = 'strong';
    else if (allFirstWithin90 && allSecondLookLikeLon) swapSuspected = 'weak';
  }

  return { points, invalidRows, swapSuspected };
}

function formatBearing(value: number | null): string {
  return value === null || !Number.isFinite(value) ? 'â€”' : fmtNumber(((value % 360) + 360) % 360, 2);
}

/** Hectare/acre companions for an area, via the shared unit conversions. */
function areaBreakdown(area: number): { ha: number; acres: number } {
  return {
    ha: convertArea(area, 'm2', 'ha'),
    acres: convertArea(area, 'm2', 'acres'),
  };
}

/** A full-size football pitch: 105 m Ã— 68 m = 7,140 mÂ² (a familiar yardstick). */
const FOOTBALL_PITCH_M2 = 105 * 68;

/** Plain-language headline shown above the technical tables. */
function polygonSentence(areaM2: number): string {
  const hectares = areaM2 / 10000;
  const pitches = areaM2 / FOOTBALL_PITCH_M2;
  if (pitches >= 1) {
    return `Your parcel is ${fmtNumber(hectares, 2)} ha â€” about ${fmtNumber(pitches, 1)} football pitches.`;
  }
  if (pitches >= 0.15) {
    return `Your parcel is ${fmtNumber(areaM2, 0)} mÂ² â€” about ${fmtNumber(pitches * 100, 0)}% of a football pitch.`;
  }
  return `Your parcel is ${fmtNumber(areaM2, 0)} mÂ² â€” smaller than a football pitch.`;
}

/**
 * Cheap column picker for imported vertex tables: prefer named coordinate
 * columns, otherwise the first two columns. Returns header keys.
 */
function pickVertexColumns(headers: ReadonlyArray<string>, mode: PolygonMode): { a: string; b: string } {
  const normalised = headers.map((header) => header.trim().toLowerCase());
  const find = (needles: ReadonlyArray<string>): number =>
    normalised.findIndex((header) =>
      needles.some((needle) => header === needle || (needle.length > 1 && header.includes(needle))),
    );

  if (mode === 'latlon') {
    const lon = find(['lon', 'long', 'longitude']);
    const lat = find(['lat', 'latitude']);
    if (lon >= 0 && lat >= 0 && lon !== lat) return { a: headers[lon], b: headers[lat] };
  } else if (mode === 'utm') {
    const easting = find(['easting', 'east', 'e']);
    const northing = find(['northing', 'north', 'n']);
    if (easting >= 0 && northing >= 0 && easting !== northing) {
      return { a: headers[easting], b: headers[northing] };
    }
  } else {
    const x = find(['x']);
    const y = find(['y']);
    if (x >= 0 && y >= 0 && x !== y) return { a: headers[x], b: headers[y] };
  }
  return { a: headers[0] ?? '', b: headers[1] ?? '' };
}

export default function PolygonTool() {
  /* --------------------------------------------------------------- input */
  const [mode, setMode] = useState<PolygonMode>('latlon');
  const [rows, setRows] = useState<VertexRow[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importWarning, setImportWarning] = useState<string | null>(null);
  const [importedName, setImportedName] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [zoneText, setZoneText] = useState('37');
  const [hemisphere, setHemisphere] = useState<Hemisphere>('S');

  /* ------------------------------------------------------------- options */
  const [useGeodesic, setUseGeodesic] = useState(true);
  const [useGround, setUseGround] = useState(false);
  const [meanElevationText, setMeanElevationText] = useState('0');
  const [csfOverrideText, setCsfOverrideText] = useState('');

  /* -------------------------------------------------------------- results */
  const [result, setResult] = useState<PolygonResult | null>(null);
  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState<string | null>(null);
  const [validationIssues, setValidationIssues] = useState<string[]>([]);
  const [dirty, setDirty] = useState(false);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [mapError, setMapError] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapChange | null>(null);
  const [mapApiReady, setMapApiReady] = useState(false);
  const [utmEngineReady, setUtmEngineReady] = useState(false);
  const [utmEngineError, setUtmEngineError] = useState<string | null>(null);

  const rowCounter = useRef(0);
  const fitRef = useRef<((points: ReadonlyArray<LatLon>) => void) | null>(null);
  const lastFitKeyRef = useRef('');
  const zoneId = useId();
  const hemiId = useId();
  const pasteId = useId();
  const fileInputId = useId();
  const meanElevationId = useId();
  const csfId = useId();

  const makeRow = useCallback((a = '', b = ''): VertexRow => {
    rowCounter.current += 1;
    return { id: `vertex-${rowCounter.current}`, a, b };
  }, []);

  const parsed = useMemo(() => parseRows(rows, mode), [rows, mode]);

  const zoneNumber = useMemo(() => {
    const parsedZone = Number.parseInt(zoneText, 10);
    return Number.isFinite(parsedZone) && parsedZone >= 1 && parsedZone <= 60 ? parsedZone : null;
  }, [zoneText]);

  const meanElevation = useMemo(() => {
    const value = Number(meanElevationText.replace(',', '.'));
    return Number.isFinite(value) ? value : 0;
  }, [meanElevationText]);

  const csfOverride = useMemo(() => {
    const trimmed = csfOverrideText.trim();
    if (!trimmed) return null;
    const value = Number(trimmed.replace(',', '.'));
    return Number.isFinite(value) && value > 0.5 && value < 2 ? value : null;
  }, [csfOverrideText]);
  const csfInvalid = csfOverrideText.trim().length > 0 && csfOverride === null;

  const geographicAvailability = mode !== 'xy';
  const effectiveGeodesic = geographicAvailability && useGeodesic;
  const effectiveGround = geographicAvailability && useGround;

  // The projection engine is a lazy chunk behind `src/math`; load it as soon as
  // a projected reference system is selected so the map overlay can render
  // before the first computation.
  useEffect(() => {
    if (mode === 'xy') return;
    let cancelled = false;
    if (isUtmEngineLoaded()) {
      setUtmEngineReady(true);
      return;
    }
    void loadUtmEngine()
      .then(() => {
        if (!cancelled) setUtmEngineReady(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setUtmEngineError(errorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [mode]);

  // Zone derived from the centroid for Geographic input (read-only display).
  const autoZone = useMemo(() => {
    if (mode !== 'latlon' || parsed.points.length === 0 || parsed.invalidRows.length > 0) return null;
    const meanLon = parsed.points.reduce((sum, point) => sum + point.a, 0) / parsed.points.length;
    const meanLat = parsed.points.reduce((sum, point) => sum + point.b, 0) / parsed.points.length;
    try {
      return utmZoneFromLonLat(meanLon, meanLat);
    } catch {
      return null;
    }
  }, [mode, parsed]);

  /* --------------------------------------------------- computed geometry */
  const geoPoints = useMemo<LatLon[]>(() => {
    if (parsed.invalidRows.length > 0 || parsed.points.length === 0) return [];
    if (mode === 'latlon') {
      return parsed.points.map((point) => ({ lon: point.a, lat: point.b }));
    }
    if (mode === 'utm' && zoneNumber !== null && utmEngineReady) {
      try {
        return parsed.points.map((point) =>
          utmToLonLat({ E: point.a, N: point.b } satisfies UtmPoint, { zone: zoneNumber, hemisphere }),
        );
      } catch {
        return [];
      }
    }
    return [];
  }, [mode, parsed, zoneNumber, hemisphere, utmEngineReady]);

  const mapMarkers = useMemo<MapMarker[]>(() => {
    if (mode === 'xy') return [];
    return geoPoints.map((point, index) => ({
      lat: point.lat,
      lon: point.lon,
      kind: 'vertex',
      label: geoPoints.length <= 30 ? fmtNumber(index + 1, 0) : undefined,
    }));
  }, [mode, geoPoints]);

  const mapPolygon = geoPoints.length >= 3 ? geoPoints : undefined;
  const mapLine = geoPoints.length >= 2 ? geoPoints : undefined;

  /* --------------------------------------------------------- dirty state */
  useEffect(() => {
    setDirty(true);
  }, [rows, mode, zoneText, hemisphere, useGeodesic, useGround, meanElevationText, csfOverrideText]);

  /* ------------------------------------------------------------- compute */
  const buildInput = useCallback(
    (rowsArg: ReadonlyArray<VertexRow>): PolygonInput | { error: string } => {
      const state = parseRows(rowsArg, mode);
      if (rowsArg.length < 3) return { error: 'A polygon needs at least three vertices.' };
      if (state.invalidRows.length > 0) {
        return {
          error: `${fmtNumber(state.invalidRows.length, 0)} vertex row${state.invalidRows.length === 1 ? '' : 's'} cannot be read. Complete or remove ${state.invalidRows.length === 1 ? 'it' : 'them'}.`,
        };
      }
      if (mode === 'xy') {
        return { mode: 'xy', points: state.points.map((point) => ({ x: point.a, y: point.b })) };
      }
      if (mode === 'utm') {
        if (zoneNumber === null) {
          return { error: 'UTM zone must be a whole number from 1 to 60.' };
        }
        return {
          mode: 'utm',
          points: state.points.map((point) => ({ E: point.a, N: point.b })),
          zone: zoneNumber,
          hemisphere,
        };
      }
      return { mode: 'latlon', points: state.points.map((point) => ({ lon: point.a, lat: point.b })) };
    },
    [mode, zoneNumber, hemisphere],
  );

  const runCompute = useCallback(
    async (rowsArg?: ReadonlyArray<VertexRow>) => {
      const sourceRows = rowsArg ?? rows;
      setComputing(true);
      setComputeError(null);
      setValidationIssues([]);
      try {
        const input = buildInput(sourceRows);
        if ('error' in input) {
          setResult(null);
          setComputeError(input.error);
          setStatusMessage('Computation blocked: check the vertices.');
          return;
        }
        const validation = validatePolygonInput(input);
        if (!validation.ok) {
          setResult(null);
          setValidationIssues(validation.errors);
          setStatusMessage('Validation failed.');
          return;
        }
        const computed = await computePolygon(input, {
          geodesic: effectiveGeodesic,
          ground: effectiveGround,
          meanElevationM: meanElevation,
          combinedScaleFactor: csfOverride ?? undefined,
        });
        setResult(computed);
        setDirty(false);
        setStatusMessage(
          `Computed ${fmtNumber(computed.vertexCount, 0)} vertices Â· grid area ${fmtNumber(computed.grid.area, 2)} mÂ².`,
        );
        const geo = computed.vertices
          .map((vertex) => vertex.geo)
          .filter((point): point is LatLon => point !== null && point !== undefined);
        if (geo.length >= 2) {
          const key = `${geo.length}:${geo[0].lat.toFixed(6)}:${geo[0].lon.toFixed(6)}:${geo[geo.length - 1].lat.toFixed(6)}`;
          lastFitKeyRef.current = key;
          fitRef.current?.(geo);
        }
      } catch (error) {
        setResult(null);
        setComputeError(errorMessage(error));
        setStatusMessage('Computation failed.');
      } finally {
        setComputing(false);
      }
    },
    [buildInput, rows, effectiveGeodesic, effectiveGround, meanElevation, csfOverride],
  );

  /* --------------------------------------------------------------- rows */
  const addRow = () => {
    setRows((previous) => [...previous, makeRow('', '')]);
    setStatusMessage('Vertex row added.');
  };

  const updateRow = (id: string, field: 'a' | 'b', value: string) => {
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const removeRow = (id: string) => {
    setRows((previous) => previous.filter((row) => row.id !== id));
    setStatusMessage('Vertex removed â€” the ring re-closes automatically.');
  };

  const moveRow = (index: number, direction: -1 | 1) => {
    setRows((previous) => {
      const target = index + direction;
      if (target < 0 || target >= previous.length) return previous;
      const next = [...previous];
      const [row] = next.splice(index, 1);
      next.splice(target, 0, row);
      return next;
    });
  };

  const clearRows = () => {
    setRows([]);
    setResult(null);
    setComputeError(null);
    setValidationIssues([]);
    setPasteError(null);
    setStatusMessage('Vertices cleared.');
  };

  const swapColumns = () => {
    setRows((previous) => previous.map((row) => ({ ...row, a: row.b, b: row.a })));
    setStatusMessage('Columns swapped â€” now in Lon, Lat order.');
  };

  const loadSample = () => {
    const sample = SAMPLES[mode];
    const next = sample.map(([a, b]) => makeRow(a, b));
    setRows(next);
    setPasteError(null);
    void runCompute(next);
    setStatusMessage(`Example parcel loaded with ${fmtNumber(next.length, 0)} vertices.`);
  };

  /* --------------------------------------------------------------- paste */
  const applyPaste = () => {
    const lines = pasteText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length === 0) {
      setPasteError('Paste at least three vertices, one per line.');
      return;
    }
    const next: VertexRow[] = [];
    const errors: number[] = [];
    lines.forEach((line, index) => {
      const parts = line.split(/[,\s;]+/).filter(Boolean);
      if (parts.length < 2) {
        errors.push(index + 1);
        return;
      }
      const a = parseVertexValue(parts[0], mode);
      const b = parseVertexValue(parts[1], mode);
      const valid =
        mode === 'latlon'
          ? a !== null && b !== null && Math.abs(a) <= 180 && Math.abs(b) <= 90
          : a !== null && b !== null;
      if (!valid) {
        errors.push(index + 1);
        return;
      }
      next.push(makeRow(parts[0], parts[1]));
    });
    if (errors.length > 0) {
      setPasteError(`Could not read a coordinate on line ${errors.slice(0, 4).join(', ')}.`);
      return;
    }
    if (next.length < 3) {
      setPasteError('A polygon needs at least three vertices.');
      return;
    }
    setRows(next);
    setPasteError(null);
    setStatusMessage(`Loaded ${fmtNumber(next.length, 0)} vertices from pasted coordinates.`);
    void runCompute(next);
  };

  /* -------------------------------------------------------- file import */
  const applyTabular = (data: TabularData, fileName: string) => {
    const headers = data.headers ?? [];
    if (headers.length < 2) {
      throw new Error('The file needs at least two coordinate columns.');
    }
    const headerLooksNumeric =
      parseVertexValue(String(headers[0] ?? ''), mode) !== null &&
      parseVertexValue(String(headers[1] ?? ''), mode) !== null;
    if (headerLooksNumeric) {
      throw new Error(
        'Add a header row naming the coordinate columns (e.g. X,Y Â· E,N Â· Lon,Lat), then re-import.',
      );
    }
    const { a: aKey, b: bKey } = pickVertexColumns(headers, mode);
    if (!aKey || !bKey || aKey === bKey) {
      throw new Error('Could not identify two coordinate columns in this file.');
    }

    const next: VertexRow[] = [];
    const skipped: number[] = [];
    data.rows.forEach((row, index) => {
      const rawA = row[aKey];
      const rawB = row[bKey];
      if (rawA === undefined || rawB === undefined) {
        skipped.push(index + 2);
        return;
      }
      const a = parseVertexValue(String(rawA), mode);
      const b = parseVertexValue(String(rawB), mode);
      const valid =
        mode === 'latlon'
          ? a !== null && b !== null && Math.abs(a) <= 180 && Math.abs(b) <= 90
          : a !== null && b !== null;
      if (!valid) {
        skipped.push(index + 2);
        return;
      }
      next.push(makeRow(String(rawA).trim(), String(rawB).trim()));
    });

    if (next.length < 3) {
      throw new Error('The file needs at least three readable vertex rows.');
    }
    setRows(next);
    setImportedName(fileName);
    setImportError(null);
    setImportWarning(
      skipped.length > 0
        ? `${fmtNumber(skipped.length, 0)} row${skipped.length === 1 ? '' : 's'} skipped (line ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? 'â€¦' : ''}).`
        : null,
    );
    setStatusMessage(`Imported ${fmtNumber(next.length, 0)} vertices from ${fileName}.`);
    void runCompute(next);
  };

  const importFile = async (file: File) => {
    setImportBusy(true);
    setImportError(null);
    setImportWarning(null);
    setImportedName(null);
    try {
      const lower = file.name.toLowerCase();
      const data: TabularData =
        lower.endsWith('.xlsx') || lower.endsWith('.xls')
          ? await parseSpreadsheet(await readFileAsArrayBuffer(file))
          : parseDelimitedText(await readFileAsText(file));
      applyTabular(data, file.name);
    } catch (error) {
      setImportError(errorMessage(error));
      setStatusMessage('Could not import the vertex file.');
    } finally {
      setImportBusy(false);
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void importFile(file);
  };

  const handleVertexDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void importFile(file);
  };

  /* --------------------------------------------------------------- mode */
  const switchMode = (next: PolygonMode) => {
    if (next === mode) return;
    // Legacy behaviour: the vertex set is kept when the reference system
    // changes. Values that are not valid in the new system are flagged by the
    // inline validation instead of being silently discarded or reinterpreted.
    setMode(next);
    setResult(null);
    setComputeError(null);
    setValidationIssues([]);
    setPasteError(null);
    setStatusMessage(
      next === 'utm'
        ? 'Reference system changed â€” existing values are now read as E, N; confirm the zone and hemisphere.'
        : next === 'xy'
          ? 'Reference system changed â€” existing values are now read as local X, Y (metres).'
          : 'Reference system changed â€” existing values are now read as Lon, Lat; invalid rows are flagged.',
    );
    lastFitKeyRef.current = '';
  };

  /* ---------------------------------------------------------------- map */
  const handleMapClick = (point: LatLon) => {
    if (mode !== 'latlon') return;
    const row = makeRow(fmtNumber(point.lon, 6), fmtNumber(point.lat, 6));
    const next = [...rows, row];
    setRows(next);
    if (next.length >= 3) void runCompute(next);
    setStatusMessage(`Vertex added from the map â€” ${fmtNumber(next.length, 0)} in the ring.`);
  };

  const handleMapReady = useCallback((api: MapCanvasApi) => {
    fitRef.current = api.fit;
    setMapApiReady(true);
  }, []);

  const handleBasemap = useCallback((change: BasemapChange) => {
    setBasemap(change);
  }, []);

  const fitMap = useCallback(() => {
    if (geoPoints.length > 0) fitRef.current?.(geoPoints);
  }, [geoPoints]);

  useEffect(() => {
    if (!mapApiReady || mode !== 'latlon' || geoPoints.length < 2) return;
    const key = `${mode}:${geoPoints.length}:${geoPoints[0].lat.toFixed(5)}:${geoPoints[0].lon.toFixed(5)}:${geoPoints[geoPoints.length - 1].lat.toFixed(5)}`;
    if (key === lastFitKeyRef.current) return;
    lastFitKeyRef.current = key;
    fitRef.current?.(geoPoints);
  }, [mapApiReady, mode, geoPoints]);

  /* ------------------------------------------------------------- exports */
  const legRows = useMemo<LegRow[]>(() => {
    if (!result) return [];
    return result.legs.map((leg, index) => ({
      key: `leg-${index}`,
      leg: String(index + 1).padStart(2, '0'),
      from: `P${fmtNumber(index + 1, 0)}`,
      to: `P${fmtNumber(((index + 1) % result.vertexCount) + 1, 0)}`,
      grid: leg.gridDistance === null ? 'â€”' : fmtNumber(leg.gridDistance, 3),
      geodesic: leg.geodesicDistance === null ? 'â€”' : fmtNumber(leg.geodesicDistance, 3),
      ground: leg.groundDistance === null ? 'â€”' : fmtNumber(leg.groundDistance, 3),
      gridBearing: formatBearing(leg.gridBearing),
      azimuth: formatBearing(leg.geodesicAzimuth),
    }));
  }, [result]);

  const legColumns = useMemo<ReadonlyArray<DataTableColumn<LegRow>>>(
    () => [
      { key: 'leg', label: 'Leg', align: 'left' },
      { key: 'from', label: 'From', align: 'left' },
      { key: 'to', label: 'To', align: 'left' },
      { key: 'grid', label: 'Grid dist.', unit: 'm' },
      { key: 'geodesic', label: 'Geodesic', unit: 'm' },
      { key: 'ground', label: 'Ground', unit: 'm' },
      { key: 'gridBearing', label: 'Grid brg.', unit: 'Â°' },
      { key: 'azimuth', label: 'Azimuth', unit: 'Â°' },
    ],
    [],
  );

  const surfaceCard = (
    key: 'grid' | 'geodesic' | 'ground',
    label: string,
    tone: 'accent' | 'default',
  ) => {
    if (!result) return null;
    const surface = result[key];
    if (!surface) return null;
    const units = areaBreakdown(surface.area);
    return (
      <Panel key={key} title={`${label} surface`} meta={key === 'grid' ? 'planar grid' : key === 'geodesic' ? 'WGS 84 ellipsoid' : 'combined scale factor'} tight>
        <ReadoutGrid label={`${label} surface area and perimeter`}>
          <Readout
            label="Area"
            value={fmtNumber(surface.area, 2)}
            unit="mÂ²"
            tone={tone}
            delta={`${fmtNumber(units.ha, 4)} ha Â· ${fmtNumber(units.acres, 4)} ac`}
            wide
          />
          <Readout label="Perimeter" value={fmtNumber(surface.perimeter, 3)} unit="m" />
          <Readout label="Hectares" value={fmtNumber(units.ha, 4)} unit="ha" />
          <Readout label="Acres" value={fmtNumber(units.acres, 4)} unit="ac" />
        </ReadoutGrid>
        {key === 'ground' && result.csf !== null ? (
          <p className="tool-hint">
            Ground surface = grid Ã· CSFÂ² with CSF {fmtNumber(result.csf, 8)} (projection k{' '}
            {fmtNumber(result.projectScaleFactor ?? Number.NaN, 8)} Ã— elevation factor{' '}
            {fmtNumber(result.elevationFactor ?? Number.NaN, 8)}).
          </p>
        ) : null}
      </Panel>
    );
  };

  const parameters = (): Array<{ label: string; value: string | number }> => {
    if (!result) return [];
    return [
      { label: 'Reference system', value: mode === 'xy' ? 'Local X/Y' : mode === 'utm' ? 'UTM' : 'Geographic (Lon/Lat)' },
      { label: 'Vertices', value: result.vertexCount },
      { label: 'Ring', value: 'auto-closed (last â†’ first)' },
      {
        label: 'UTM zone',
        value: result.zone === null ? 'n/a' : `${fmtNumber(result.zone, 0)}${result.hemisphere ?? ''}${result.zoneAuto ? ' (auto)' : ''}`,
      },
      { label: 'Geodesic surface', value: result.geodesic ? 'yes' : 'no' },
      { label: 'Ground surface', value: result.ground ? 'yes' : 'no' },
      { label: 'Mean elevation', value: `${fmtNumber(useGround ? meanElevation : 0, 3)} m` },
      { label: 'CSF', value: result.csf === null ? 'n/a' : fmtNumber(result.csf, 8) },
    ];
  };

  const formattedSummary = (): Record<string, unknown> => {
    if (!result) return {};
    return {
      gridAreaM2: fmtNumber(result.grid.area, 2),
      gridPerimeterM: fmtNumber(result.grid.perimeter, 3),
      geodesicAreaM2: result.geodesic ? fmtNumber(result.geodesic.area, 2) : null,
      geodesicPerimeterM: result.geodesic ? fmtNumber(result.geodesic.perimeter, 3) : null,
      groundAreaM2: result.ground ? fmtNumber(result.ground.area, 2) : null,
      groundPerimeterM: result.ground ? fmtNumber(result.ground.perimeter, 3) : null,
      csf: result.csf === null ? null : fmtNumber(result.csf, 8),
    };
  };

  const runExport = async (kind: ExportKind) => {
    if (!result) return;
    setExporting(kind);
    setExportError(null);
    try {
      const slug = 'polygon-area';
      const rawLegs = result.legs.map((leg, index) => ({
        leg: index + 1,
        from: index + 1,
        to: ((index + 1) % result.vertexCount) + 1,
        gridDistanceM: leg.gridDistance,
        geodesicDistanceM: leg.geodesicDistance,
        groundDistanceM: leg.groundDistance,
        gridBearingDeg: leg.gridBearing,
        azimuthDeg: leg.geodesicAzimuth,
        gridE: result.vertices[index]?.grid?.E ?? null,
        gridN: result.vertices[index]?.grid?.N ?? null,
        lon: result.vertices[index]?.geo?.lon ?? null,
        lat: result.vertices[index]?.geo?.lat ?? null,
      }));

      if (kind === 'csv') {
        exportCSV(
          exportFilename(slug, 'csv'),
          [
            { key: 'leg', label: 'Leg' },
            { key: 'from', label: 'From vertex' },
            { key: 'to', label: 'To vertex' },
            { key: 'gridE', label: 'From E', unit: 'm' },
            { key: 'gridN', label: 'From N', unit: 'm' },
            { key: 'gridDistanceM', label: 'Grid distance', unit: 'm' },
            { key: 'geodesicDistanceM', label: 'Geodesic distance', unit: 'm' },
            { key: 'groundDistanceM', label: 'Ground distance', unit: 'm' },
            { key: 'gridBearingDeg', label: 'Grid bearing', unit: 'deg' },
            { key: 'azimuthDeg', label: 'Azimuth', unit: 'deg' },
            { key: 'lon', label: 'From longitude', unit: 'deg' },
            { key: 'lat', label: 'From latitude', unit: 'deg' },
          ],
          rawLegs,
          [
            'Geodesia â€” Polygon Area',
            `Reference system: ${mode === 'xy' ? 'Local X/Y' : mode === 'utm' ? `UTM ${zoneText}${hemisphere}` : `Geographic (auto UTM ${result.zone ?? ''}${result.hemisphere ?? ''})`}`,
            `Grid area: ${fmtNumber(result.grid.area, 2)} m2 Â· perimeter ${fmtNumber(result.grid.perimeter, 3)} m`,
            `Geodesic area: ${result.geodesic ? `${fmtNumber(result.geodesic.area, 2)} m2 Â· perimeter ${fmtNumber(result.geodesic.perimeter, 3)} m` : 'n/a'}`,
            `Ground area: ${result.ground ? `${fmtNumber(result.ground.area, 2)} m2 Â· perimeter ${fmtNumber(result.ground.perimeter, 3)} m` : 'n/a'}`,
            `CSF: ${result.csf === null ? 'n/a' : fmtNumber(result.csf, 8)} Â· mean elevation ${fmtNumber(useGround ? meanElevation : 0, 3)} m`,
            `Generated: ${timestamp()}`,
          ],
        );
      } else if (kind === 'json') {
        exportJSON(
          exportFilename(slug, 'json'),
          buildVerification(
            {
              tool: 'Polygon Area',
              title: 'Parcel area and closure report (grid / geodesic / ground)',
              method:
                'Gaussian shoelace on projected UTM grid coordinates; Karney ellipsoidal geodesic area/perimeter on WGS 84; ground surface via combined scale factor (k Â· EF)',
              parameters: Object.fromEntries(parameters().map((entry) => [entry.label, entry.value])),
              notes: [...result.warnings],
            },
            {
              ...result,
              formatted: formattedSummary(),
            },
          ),
        );
      } else {
        const spec: PdfReportSpec = {
          meta: {
            tool: 'Polygon Area',
            title: 'Parcel area and closure report',
            subtitle: `${fmtNumber(result.vertexCount, 0)} vertices Â· ${mode === 'xy' ? 'Local X/Y grid' : mode === 'utm' ? `UTM ${zoneText}${hemisphere}` : 'Geographic (auto UTM)'}`,
            parameters: parameters(),
            notes: [
              'Grid area uses the Gaussian shoelace on projected coordinates (ring translated to its first vertex).',
              'Geodesic area/perimeter use the WGS 84 ellipsoid (Karney), never a sphere approximation.',
              'Ground distance = grid distance Ã· CSF; ground area = grid area Ã· CSFÂ².',
              ...result.warnings,
            ],
          },
          sections: [
            {
              kind: 'kv',
              heading: 'Grid surface',
              rows: [
                { label: 'Grid area', value: `${fmtNumber(result.grid.area, 2)} mÂ²`, emphasis: true },
                { label: 'Grid perimeter', value: `${fmtNumber(result.grid.perimeter, 3)} m` },
                { label: 'Hectares', value: `${fmtNumber(areaBreakdown(result.grid.area).ha, 4)} ha` },
                { label: 'Acres', value: `${fmtNumber(areaBreakdown(result.grid.area).acres, 4)} ac` },
                {
                  label: 'UTM zone',
                  value:
                    result.zone === null
                      ? 'n/a'
                      : `${fmtNumber(result.zone, 0)}${result.hemisphere ?? ''}${result.zoneAuto ? ' (auto from centroid)' : ''}`,
                },
                { label: 'Closure (last â†’ first)', value: `${fmtNumber(result.closure, 3)} m` },
              ],
            },
            ...(result.geodesic
              ? [
                  {
                    kind: 'kv' as const,
                    heading: 'Geodesic surface (WGS 84)',
                    rows: [
                      { label: 'Geodesic area', value: `${fmtNumber(result.geodesic.area, 2)} mÂ²`, emphasis: true },
                      { label: 'Geodesic perimeter', value: `${fmtNumber(result.geodesic.perimeter, 3)} m` },
                    ],
                  },
                ]
              : []),
            ...(result.ground
              ? [
                  {
                    kind: 'kv' as const,
                    heading: 'Ground surface (CSF)',
                    rows: [
                      { label: 'Ground area', value: `${fmtNumber(result.ground.area, 2)} mÂ²`, emphasis: true },
                      { label: 'Ground perimeter', value: `${fmtNumber(result.ground.perimeter, 3)} m` },
                      { label: 'Combined scale factor', value: fmtNumber(result.csf ?? Number.NaN, 8) },
                      { label: 'Projection scale factor k', value: fmtNumber(result.projectScaleFactor ?? Number.NaN, 8) },
                      { label: 'Elevation factor', value: fmtNumber(result.elevationFactor ?? Number.NaN, 8) },
                      { label: 'Mean elevation', value: `${fmtNumber(meanElevation, 3)} m` },
                    ],
                  },
                ]
              : []),
            {
              kind: 'table',
              heading: 'Vector legs',
              columns: [
                { label: 'Leg', align: 'left' },
                { label: 'From', align: 'left' },
                { label: 'To', align: 'left' },
                { label: 'Grid', unit: 'm', align: 'right' },
                { label: 'Geodesic', unit: 'm', align: 'right' },
                { label: 'Ground', unit: 'm', align: 'right' },
                { label: 'Grid brg.', unit: 'deg', align: 'right' },
                { label: 'Azimuth', unit: 'deg', align: 'right' },
              ],
              rows: legRows.map((row) => [
                row.leg,
                row.from,
                row.to,
                row.grid,
                row.geodesic,
                row.ground,
                row.gridBearing,
                row.azimuth,
              ]),
              footnote: `Totals Â· grid ${fmtNumber(result.grid.perimeter, 3)} m Â· geodesic ${result.geodesic ? `${fmtNumber(result.geodesic.perimeter, 3)} m` : 'n/a'} Â· ground ${result.ground ? `${fmtNumber(result.ground.perimeter, 3)} m` : 'n/a'}`,
            },
          ],
        };
        await exportPDF(spec);
      }
      setStatusMessage(`Exported ${kind.toUpperCase()} file.`);
    } catch (error) {
      setExportError(errorMessage(error));
    } finally {
      setExporting(null);
    }
  };

  /* --------------------------------------------------------------- render */
  const invalidCount = parsed.invalidRows.length;
  const plotVertices =
    mode === 'xy'
      ? parsed.points.map((point) => ({ x: point.a, y: point.b }))
      : mode === 'utm'
        ? parsed.points.map((point) => ({ x: point.a, y: point.b }))
        : [];

  const plotLegDistances =
    mode !== 'latlon' && parsed.points.length >= 3
      ? parsed.points.map((point, index) => {
          const next = parsed.points[(index + 1) % parsed.points.length];
          return Math.hypot(next.a - point.a, next.b - point.b);
        })
      : [];

  const centroidGrid = result?.centroid.grid ?? null;
  const centroidGeo = result?.centroid.geo ?? null;

  const zoneLabel = result
    ? result.zone === null
      ? 'n/a'
      : `${fmtNumber(result.zone, 0)}${result.hemisphere ?? ''}${result.zoneAuto ? ' auto' : ''}`
    : autoZone
      ? `${fmtNumber(autoZone.zone, 0)}${autoZone.hemisphere} auto`
      : 'n/a';

  /* Headline surface: the plain-language sentence leads with the geodesic area
     when it exists (WGS 84 is what most clients mean by "the area"), then the
     ground surface, then the planar grid. */
  const headline = result === null ? null : (result.geodesic ?? result.ground ?? result.grid);
  const headlineLabel = result?.geodesic ? 'geodesic' : result?.ground ? 'ground' : 'grid';

  return (
    <div className="tool-page">
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>

      <div className="tool-stage">
        {/* ------------------------------------------------------- controls */}
        <div className="tool-stage__side">
          <section className="step-card" aria-labelledby="polygon-step-1">
            <div className="step-card__head">
              <span className="step-card__num" aria-hidden="true">
                1
              </span>
              <h3 className="step-card__title" id="polygon-step-1">
                Pick your corners
              </h3>
            </div>
            <div className="step-card__body">
              <Segmented
                options={modeOptions}
                value={mode}
                onChange={switchMode}
                label="Reference system"
                className="segmented--full"
              />
              <p className="tool-hint">{MODE_HINTS[mode]}</p>
              {mode === 'utm' ? (
                <div className="field-row">
                  <Field label="UTM zone" htmlFor={zoneId} hint="1â€“60">
                    <input
                      id={zoneId}
                      className="input"
                      type="number"
                      min={1}
                      max={60}
                      step={1}
                      value={zoneText}
                      aria-invalid={(mode === 'utm' && zoneNumber === null) || undefined}
                      onChange={(event) => setZoneText(event.target.value)}
                    />
                  </Field>
                  <Field label="Hemisphere" htmlFor={hemiId}>
                    <select
                      id={hemiId}
                      className="select"
                      value={hemisphere}
                      onChange={(event) => setHemisphere(event.target.value === 'N' ? 'N' : 'S')}
                    >
                      {HEMISPHERES.map((entry) => (
                        <option key={entry.value} value={entry.value}>
                          {entry.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                </div>
              ) : null}
              {mode === 'latlon' ? (
                <p className="tool-hint">
                  Map clicks write <strong>Lon, Lat</strong> corners. Auto UTM zone: {zoneLabel}.
                </p>
              ) : null}
            </div>
          </section>

          <section className="step-card" aria-labelledby="polygon-step-2">
            <div className="step-card__head">
              <span className="step-card__num" aria-hidden="true">
                2
              </span>
              <h3 className="step-card__title" id="polygon-step-2">
                Check the shape
              </h3>
              <span className="step-card__status">
                {fmtNumber(rows.length, 0)} {rows.length === 1 ? 'corner' : 'corners'}
              </span>
            </div>
            <div className="step-card__body">
              <p className="tool-hint">
                The ring closes automatically from the last corner back to the first â€” do not repeat the
                first corner. Current order:{' '}
                {mode === 'xy' ? 'X, Y' : mode === 'utm' ? 'E, N' : 'Lon, Lat'}.
              </p>
              {invalidCount > 0 ? (
                <Notice tone="warn">
                  {fmtNumber(invalidCount, 0)} row{invalidCount === 1 ? '' : 's'} cannot be read yet.
                  Complete or remove {invalidCount === 1 ? 'it' : 'them'} to calculate.
                </Notice>
              ) : null}
              {mode === 'latlon' && parsed.swapSuspected ? (
                <Notice
                  tone={parsed.swapSuspected === 'strong' ? 'err' : 'warn'}
                  title={parsed.swapSuspected === 'strong' ? 'Corners look swapped' : 'Check the corner order'}
                  action={
                    <button type="button" className="btn btn--sm" onClick={swapColumns}>
                      Swap to Lon, Lat
                    </button>
                  }
                >
                  This instrument expects <strong>Lon, Lat</strong> order. These values look like Lat,
                  Lon â€” if the map or results are displaced, swap the columns.
                </Notice>
              ) : null}
              {computeError ? <Notice tone="err">{computeError}</Notice> : null}
              {validationIssues.length > 0 ? (
                <Notice tone="err" title="Check the corners">
                  <ul className="issue-list">
                    {validationIssues.map((issue, index) => (
                      <li key={`issue-${index}`}>{issue}</li>
                    ))}
                  </ul>
                </Notice>
              ) : null}
              {dirty && result ? (
                <Notice tone="info">Corners changed â€” calculate again to refresh the result.</Notice>
              ) : null}
              <button
                type="button"
                className="btn btn--primary btn--block"
                onClick={() => void runCompute()}
                disabled={computing}
              >
                <IconCrosshair size={15} /> {computing ? 'Calculatingâ€¦' : 'Calculate area'}
              </button>

              <details className="advanced">
                <summary>Edit corners by hand</summary>
                <div className="advanced__body">
                  <div className="btn-row">
                    <button type="button" className="btn btn--sm" onClick={addRow}>
                      <IconPlus size={14} /> Add corner
                    </button>
                    <button
                      type="button"
                      className="btn btn--sm btn--quiet"
                      onClick={clearRows}
                      disabled={rows.length === 0}
                    >
                      <IconTrash size={14} /> Clear all
                    </button>
                  </div>
                  {rows.length === 0 ? (
                    <p className="tool-hint">
                      No corners yet â€” click the map, paste a coordinate list, or add rows here.
                    </p>
                  ) : (
                    <div className="vertex-table-wrap">
                      <table className="data-table vertex-table">
                        <caption className="sr-only">Polygon vertices, editable</caption>
                        <thead>
                          <tr>
                            <th scope="col" className="is-left">
                              #
                            </th>
                            <th scope="col">
                              {mode === 'xy' ? 'X (m)' : mode === 'utm' ? 'E (m)' : 'Longitude'}
                            </th>
                            <th scope="col">
                              {mode === 'xy' ? 'Y (m)' : mode === 'utm' ? 'N (m)' : 'Latitude'}
                            </th>
                            <th scope="col" className="is-left">
                              <span className="sr-only">Row actions</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {rows.map((row, index) => {
                            const invalid = parsed.invalidRows.includes(index);
                            const aValue = parseVertexValue(row.a, mode);
                            const bValue = parseVertexValue(row.b, mode);
                            return (
                              <tr key={row.id}>
                                <td className="is-left vertex-table__index">{fmtNumber(index + 1, 0)}</td>
                                <td>
                                  <input
                                    className="input input--cell"
                                    value={row.a}
                                    inputMode="decimal"
                                    aria-label={`Vertex ${index + 1} ${
                                      mode === 'xy' ? 'X' : mode === 'utm' ? 'E' : 'longitude'
                                    }`}
                                    aria-invalid={invalid || undefined}
                                    placeholder={
                                      mode === 'xy' ? '0.000' : mode === 'utm' ? '253000' : '36.817200'
                                    }
                                    onChange={(event) => updateRow(row.id, 'a', event.target.value)}
                                  />
                                  {mode === 'latlon' && aValue !== null && Math.abs(aValue) <= 180 ? (
                                    <span className="vertex-table__dms">{formatDMS(aValue, 2, 'lon')}</span>
                                  ) : null}
                                </td>
                                <td>
                                  <input
                                    className="input input--cell"
                                    value={row.b}
                                    inputMode="decimal"
                                    aria-label={`Vertex ${index + 1} ${
                                      mode === 'xy' ? 'Y' : mode === 'utm' ? 'N' : 'latitude'
                                    }`}
                                    aria-invalid={invalid || undefined}
                                    placeholder={
                                      mode === 'xy' ? '0.000' : mode === 'utm' ? '9858000' : '-1.286400'
                                    }
                                    onChange={(event) => updateRow(row.id, 'b', event.target.value)}
                                  />
                                  {mode === 'latlon' && bValue !== null && Math.abs(bValue) <= 90 ? (
                                    <span className="vertex-table__dms">{formatDMS(bValue, 2, 'lat')}</span>
                                  ) : null}
                                </td>
                                <td className="is-left vertex-table__actions">
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--xs"
                                    onClick={() => moveRow(index, -1)}
                                    disabled={index === 0}
                                    aria-label={`Move vertex ${index + 1} up`}
                                  >
                                    <IconArrowUp size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--xs"
                                    onClick={() => moveRow(index, 1)}
                                    disabled={index === rows.length - 1}
                                    aria-label={`Move vertex ${index + 1} down`}
                                  >
                                    <IconArrowDown size={13} />
                                  </button>
                                  <button
                                    type="button"
                                    className="icon-btn icon-btn--xs"
                                    onClick={() => removeRow(row.id)}
                                    aria-label={`Remove vertex ${index + 1}`}
                                  >
                                    <IconTrash size={13} />
                                  </button>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              </details>

              <details className="advanced">
                <summary>Paste or upload coordinates</summary>
                <div className="advanced__body">
                  <Field
                    label="Paste coordinates"
                    htmlFor={pasteId}
                    hint={
                      mode === 'xy'
                        ? 'One â€œX, Yâ€ pair per line (metres)'
                        : mode === 'utm'
                          ? 'One â€œE, Nâ€ pair per line (metres)'
                          : 'One â€œLon, Latâ€ pair per line â€” decimal or DMS'
                    }
                  >
                    <textarea
                      id={pasteId}
                      className="textarea"
                      rows={4}
                      value={pasteText}
                      placeholder={
                        mode === 'xy'
                          ? '0, 0\n120, 0\n120, 80\n0, 80'
                          : mode === 'utm'
                            ? '253000, 9858000\n253120, 9858000\n253120, 9858080'
                            : '36.8172, -1.2864\n36.8189, -1.2864\n36.8189, -1.2876'
                      }
                      onChange={(event) => setPasteText(event.target.value)}
                    />
                  </Field>
                  {pasteError ? <Notice tone="err">{pasteError}</Notice> : null}
                  <div className="btn-row">
                    <button
                      type="button"
                      className="btn btn--sm"
                      onClick={applyPaste}
                      disabled={!pasteText.trim()}
                    >
                      <IconGrid size={14} /> Load corners
                    </button>
                    <button type="button" className="btn btn--sm btn--quiet" onClick={loadSample}>
                      Load example
                    </button>
                  </div>
                  <div className="dropzone-wrap">
                    <label
                      className="dropzone dropzone--compact"
                      htmlFor={fileInputId}
                      data-dragging={dragging || undefined}
                      onDragOver={(event) => {
                        event.preventDefault();
                        setDragging(true);
                      }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={handleVertexDrop}
                    >
                      <IconUpload size={16} />
                      <span className="dropzone__title">
                        {importBusy ? 'Reading cornersâ€¦' : 'Drop CSV, TXT or XLSX'}
                      </span>
                      <span className="dropzone__hint">
                        two coordinate columns Â·{' '}
                        {mode === 'latlon' ? 'Lon, Lat' : mode === 'utm' ? 'E, N' : 'X, Y'}
                      </span>
                    </label>
                    <input
                      id={fileInputId}
                      type="file"
                      accept=".csv,.txt,.tsv,.xlsx,.xls"
                      className="sr-only"
                      onChange={handleFileInput}
                    />
                  </div>
                  {importedName ? (
                    <p className="tool-hint">
                      Imported <strong>{importedName}</strong> â€” check the reference system and column
                      order.
                    </p>
                  ) : null}
                  {importWarning ? <Notice tone="warn">{importWarning}</Notice> : null}
                  {importError ? <Notice tone="err">{importError}</Notice> : null}
                </div>
              </details>
            </div>
          </section>

          <details className="advanced">
            <summary>Advanced options</summary>
            <div className="advanced__body">
              <label className="check">
                <input
                  type="checkbox"
                  checked={effectiveGeodesic}
                  disabled={!geographicAvailability}
                  onChange={(event) => setUseGeodesic(event.target.checked)}
                />
                <span>
                  Geodesic surface
                  <span className="check__note">WGS 84 ellipsoid area &amp; perimeter</span>
                </span>
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={effectiveGround}
                  disabled={!geographicAvailability}
                  onChange={(event) => setUseGround(event.target.checked)}
                />
                <span>
                  Ground surface (CSF)
                  <span className="check__note">grid Ã· CSF and grid Ã· CSFÂ²</span>
                </span>
              </label>
              {effectiveGround ? (
                <div className="field-row">
                  <Field
                    label="Mean elevation"
                    htmlFor={meanElevationId}
                    unit="m"
                    hint="Ellipsoidal height used by the elevation factor"
                  >
                    <input
                      id={meanElevationId}
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={meanElevationText}
                      onChange={(event) => setMeanElevationText(event.target.value)}
                    />
                  </Field>
                  <Field
                    label="CSF override"
                    htmlFor={csfId}
                    unit="optional"
                    hint="User-supplied combined scale factor"
                  >
                    <input
                      id={csfId}
                      className="input"
                      type="text"
                      inputMode="decimal"
                      value={csfOverrideText}
                      placeholder="0.999600"
                      aria-invalid={csfInvalid || undefined}
                      onChange={(event) => setCsfOverrideText(event.target.value)}
                    />
                  </Field>
                </div>
              ) : null}
              {csfInvalid ? <Notice tone="err">CSF override must be between 0.5 and 2.</Notice> : null}
              {!geographicAvailability ? (
                <Notice tone="info">
                  Local X/Y has no geographic reference, so only the grid surface can be calculated.
                </Notice>
              ) : null}
              {result ? (
                <div className="formula">
                  <p className="formula__name">Combined scale factor</p>
                  <p className="formula__body">
                    CSF = k Â· EF &nbsp;Â·&nbsp; k = kâ‚€(1 + xÂ²/2RÂ²) &nbsp;Â·&nbsp; EF = a/(a+h)
                  </p>
                  <p className="formula__note">
                    kâ‚€ = 0.9996, x = meanE âˆ’ 500 000 m, R = âˆš(MÂ·N) at the centroid latitude. Ground
                    distance = grid Ã· CSF; ground area = grid Ã· CSFÂ².{' '}
                    {result.csf === null
                      ? 'CSF is not applicable for this input.'
                      : `Computed CSF ${fmtNumber(result.csf, 8)}.`}
                  </p>
                </div>
              ) : null}
            </div>
          </details>
        </div>

        {/* ----------------------------------------------------------- hero */}
        <div className="tool-stage__hero">
          {mode === 'latlon' ? (
            <Panel
              className="stage-panel stage-panel--map"
              title="Parcel map"
              meta={`${fmtNumber(geoPoints.length, 0)} corners Â· click the map to add`}
              actions={
                <Toolbar label="Map actions">
                  <button
                    type="button"
                    className="btn btn--sm btn--quiet"
                    onClick={fitMap}
                    disabled={geoPoints.length === 0}
                  >
                    Fit
                  </button>
                </Toolbar>
              }
            >
              <div className="stage-hero">
                <MapCanvas
                  mode="polygon"
                  center={MAP_DEFAULT_VIEW.center}
                  zoom={MAP_DEFAULT_VIEW.zoom}
                  markers={mapMarkers}
                  polygon={mapPolygon}
                  line={mapLine}
                  onMapClick={handleMapClick}
                  onMapError={setMapError}
                  onBasemapChange={handleBasemap}
                  onReady={handleMapReady}
                  ariaLabel="Parcel map: click the map to add corners in ring order"
                >
                  <div className="map-overlay map-overlay--tl">
                    <p className="map-hint">
                      <strong>Click the map to add corners</strong> in ring order â€” at least three. Zoom
                      in to see plots and boundaries. The ring closes from the last corner back to the
                      first.
                    </p>
                  </div>
                </MapCanvas>
              </div>
              {mapError ? (
                <Notice tone="warn" title="Map unavailable">
                  {mapError} The editable corner table and the calculation still work â€” the parcel can be
                  entered, calculated and exported without the basemap.
                </Notice>
              ) : null}
            </Panel>
          ) : (
            <Panel
              className="stage-panel"
              title={mode === 'xy' ? 'Coordinate sheet' : 'Grid coordinate sheet'}
              meta={mode === 'xy' ? 'local X/Y Â· metres' : `UTM ${zoneText}${hemisphere} Â· metres`}
              tight
            >
              <div className="stage-hero stage-hero--plot">
                <PlotSurface
                  vertices={plotVertices.map((vertex, index) => ({
                    ...vertex,
                    label: fmtNumber(index + 1, 0),
                  }))}
                  centroid={centroidGrid ? { x: centroidGrid.E, y: centroidGrid.N } : null}
                  legDistances={plotLegDistances}
                  areaM2={result?.grid.area ?? null}
                  perimeterM={result?.grid.perimeter ?? null}
                  axisLabels={mode === 'xy' ? { x: 'X (m)', y: 'Y (m)' } : { x: 'E (m)', y: 'N (m)' }}
                  northLabel={mode === 'xy' ? 'Y' : 'N'}
                  title={mode === 'xy' ? 'Local grid plot' : 'UTM grid plot'}
                />
              </div>
            </Panel>
          )}
        </div>
      </div>

      {/* -------------------------------------------------------------- results */}
      <div className="tool-results">
        <Panel
          title="3 Â· Read the result"
          meta={headline ? `${fmtNumber(result?.vertexCount ?? 0, 0)} corners Â· ${headlineLabel} area` : 'Awaiting calculation'}
          actions={
            <Toolbar label="Export results">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('csv')}
                disabled={!result || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'csv' ? 'CSVâ€¦' : 'CSV'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('json')}
                disabled={!result || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'json' ? 'JSONâ€¦' : 'JSON'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('pdf')}
                disabled={!result || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'pdf' ? 'PDFâ€¦' : 'PDF'}
              </button>
            </Toolbar>
          }
          footer={
            <span className="panel__meta">
              {result
                ? `Grid ${fmtNumber(result.grid.area, 2)} mÂ²${result.geodesic ? ` Â· geodesic ${fmtNumber(result.geodesic.area, 2)} mÂ²` : ''}${result.ground ? ` Â· ground ${fmtNumber(result.ground.area, 2)} mÂ²` : ''}`
                : 'Reference system Â· WGS 84 Â· all calculations are client-side'}
            </span>
          }
        >
          {headline ? (
            <>
              <div className="result-line">
                <p className="result-line__text">{polygonSentence(headline.area)}</p>
                <div className="unit-chips">
                  <span className="unit-chip unit-chip--accent">
                    <strong>{fmtNumber(headline.area / 10000, 2)} hectares</strong>
                  </span>
                  <span className="unit-chip">
                    <strong>{fmtNumber(convertArea(headline.area, 'm2', 'acres'), 2)} acres</strong>
                  </span>
                  <span className="unit-chip">
                    <strong>{fmtNumber(headline.area, 0)} mÂ²</strong> square metres
                  </span>
                  <span className="unit-chip">
                    <strong>{fmtNumber(convertArea(headline.area, 'm2', 'roods'), 1)} roods</strong> on
                    older deeds
                  </span>
                  <span className="unit-chip">
                    <strong>{fmtNumber(headline.perimeter, 0)} m</strong> around the boundary
                  </span>
                </div>
              </div>
              {result?.selfIntersecting ? (
                <Notice tone="err" title="The boundary crosses itself">
                  The corners are in a bow-tie order. A survey cannot use a self-intersecting parcel â€”
                  reorder or move the crossing corners. Areas are still shown for diagnosis.
                </Notice>
              ) : null}
              {result && result.warnings.length > 0 ? (
                <div className="stack stack--sm">
                  {result.warnings.map((warning, index) => (
                    <Notice key={`warning-${index}`} tone="warn">
                      {warning}
                    </Notice>
                  ))}
                </div>
              ) : null}
              <p className="tool-hint">
                Headline area is the {headlineLabel} surface. Every surface is listed below, with the
                closure, centroid and scale factors in Technical details.
              </p>
            </>
          ) : (
            <EmptyState icon={<IconGrid size={22} />} title="No area yet">
              {mode === 'latlon'
                ? 'Click at least three corners on the map, then press Calculate area.'
                : 'Add at least three corners in the table or paste a coordinate list, then press Calculate area.'}
            </EmptyState>
          )}
          {exportError ? <Notice tone="err">{exportError}</Notice> : null}
        </Panel>

        {result ? (
          <>
            <div className="surface-cards">
              {surfaceCard('grid', 'Grid', 'accent')}
              {surfaceCard('geodesic', 'Geodesic', 'default')}
              {surfaceCard('ground', 'Ground', 'default')}
            </div>

            <details className="advanced">
              <summary>Technical details</summary>
              <div className="advanced__body">
                <ReadoutGrid label="Closure, centroid and scale factors">
                  <Readout
                    label="Closure (last â†’ first)"
                    value={fmtNumber(result.closure, 3)}
                    unit="m"
                    delta="auto-close leg"
                  />
                  <Readout
                    label="UTM zone"
                    value={zoneLabel}
                    delta={result.zoneAuto ? 'auto from centroid' : 'user supplied'}
                  />
                  <Readout
                    label="Centroid E"
                    value={centroidGrid ? fmtNumber(centroidGrid.E, 3) : 'â€”'}
                    unit={centroidGrid ? 'm' : undefined}
                  />
                  <Readout
                    label="Centroid N"
                    value={centroidGrid ? fmtNumber(centroidGrid.N, 3) : 'â€”'}
                    unit={centroidGrid ? 'm' : undefined}
                  />
                  {centroidGeo ? (
                    <>
                      <Readout
                        label="Centroid longitude"
                        value={formatDD(centroidGeo.lon, 6, 'lon')}
                        delta={formatDMS(centroidGeo.lon, 3, 'lon')}
                      />
                      <Readout
                        label="Centroid latitude"
                        value={formatDD(centroidGeo.lat, 6, 'lat')}
                        delta={formatDMS(centroidGeo.lat, 3, 'lat')}
                      />
                    </>
                  ) : null}
                  <Readout
                    label="Projection scale factor k"
                    value={
                      result.projectScaleFactor === null
                        ? 'â€”'
                        : fmtNumber(result.projectScaleFactor, 8)
                    }
                    delta="k = kâ‚€(1 + xÂ²/2RÂ²)"
                  />
                  <Readout
                    label="Elevation factor"
                    value={result.elevationFactor === null ? 'â€”' : fmtNumber(result.elevationFactor, 8)}
                    delta="EF = a/(a+h)"
                  />
                  <Readout
                    label="CSF"
                    value={result.csf === null ? 'â€”' : fmtNumber(result.csf, 8)}
                    delta={csfOverride !== null ? 'user override' : 'k Ã— EF'}
                  />
                </ReadoutGrid>

                <div>
                  <h4 className="panel__title">Vector legs</h4>
                  <DataTable
                    columns={legColumns}
                    rows={legRows}
                    rowKey={(row) => row.key}
                    caption="Polygon legs: grid distance, geodesic distance, ground distance, grid bearing and azimuth."
                    footer={[
                      'Î£',
                      '',
                      '',
                      fmtNumber(result.grid.perimeter, 3),
                      result.geodesic ? fmtNumber(result.geodesic.perimeter, 3) : 'â€”',
                      result.ground ? fmtNumber(result.ground.perimeter, 3) : 'â€”',
                      '',
                      '',
                    ]}
                    empty={<EmptyState title="No legs">Add at least three vertices and calculate.</EmptyState>}
                  />
                  <p className="tool-hint">
                    Totals row: grid perimeter {fmtNumber(result.grid.perimeter, 3)} m
                    {result.geodesic
                      ? ` Â· geodesic ${fmtNumber(result.geodesic.perimeter, 3)} m`
                      : ''}
                    {result.ground ? ` Â· ground ${fmtNumber(result.ground.perimeter, 3)} m` : ''}. Bearings
                    are clockwise from grid north; azimuths are forward azimuths on WGS 84.
                  </p>
                </div>
              </div>
            </details>

            {mode === 'utm' ? (
              <details className="advanced">
                <summary>Map check</summary>
                <div className="advanced__body">
                  <div className="map-check">
                    <MapCanvas
                      mode="view"
                      center={MAP_DEFAULT_VIEW.center}
                      zoom={MAP_DEFAULT_VIEW.zoom}
                      markers={mapMarkers}
                      polygon={mapPolygon}
                      line={mapLine}
                      onMapError={setMapError}
                      onBasemapChange={handleBasemap}
                      onReady={handleMapReady}
                      ariaLabel="UTM parcel overlay map"
                    />
                  </div>
                  <p className="tool-hint">
                    <strong>Grid ring projected to lon/lat</strong> with the entered zone and hemisphere.
                    Edit E/N in the table or paste; the map is a spatial check, not an input.
                  </p>
                  {utmEngineReady && geoPoints.length === 0 && parsed.points.length > 0 ? (
                    <Notice tone="warn">
                      The ring could not be projected for the map check. Check the UTM zone and
                      hemisphere â€” grid results are unaffected.
                    </Notice>
                  ) : null}
                  {utmEngineError ? (
                    <Notice tone="warn" title="Projection engine unavailable">
                      {utmEngineError} Grid results for UTM and geographic input need this engine; the
                      values already calculated remain valid, and a reload retries the download.
                    </Notice>
                  ) : null}
                </div>
              </details>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
