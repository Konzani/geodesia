/**
 * GEODESIA — Polygon Area instrument (legacy methodology, v2 contract).
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
  xy: 'Local Cartesian metres (arbitrary origin). Planar shoelace area and perimeter only — no map, no geodesic reference.',
  utm: 'WGS 84 / UTM grid coordinates. Enter E, N and the zone + hemisphere; grid results are planar, with optional geodesic and ground surfaces.',
  latlon: 'WGS 84 geographic degrees in Lon, Lat order (decimal or DMS). Click the map to add vertices; the UTM zone is derived automatically from the centroid.',
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
  return value === null || !Number.isFinite(value) ? '—' : fmtNumber(((value % 360) + 360) % 360, 2);
}

/** Hectare/acre companions for an area, via the shared unit conversions. */
function areaBreakdown(area: number): { ha: number; acres: number } {
  return {
    ha: convertArea(area, 'm2', 'ha'),
    acres: convertArea(area, 'm2', 'acres'),
  };
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
  const [mode, setMode] = useState<PolygonMode>('xy');
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
          `Computed ${fmtNumber(computed.vertexCount, 0)} vertices · grid area ${fmtNumber(computed.grid.area, 2)} m².`,
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
    setStatusMessage('Vertex removed — the ring re-closes automatically.');
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
    setStatusMessage('Columns swapped — now in Lon, Lat order.');
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
        'Add a header row naming the coordinate columns (e.g. X,Y · E,N · Lon,Lat), then re-import.',
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
        ? `${fmtNumber(skipped.length, 0)} row${skipped.length === 1 ? '' : 's'} skipped (line ${skipped.slice(0, 4).join(', ')}${skipped.length > 4 ? '…' : ''}).`
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
        ? 'Reference system changed — existing values are now read as E, N; confirm the zone and hemisphere.'
        : next === 'xy'
          ? 'Reference system changed — existing values are now read as local X, Y (metres).'
          : 'Reference system changed — existing values are now read as Lon, Lat; invalid rows are flagged.',
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
    setStatusMessage(`Vertex added from the map — ${fmtNumber(next.length, 0)} in the ring.`);
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
      grid: leg.gridDistance === null ? '—' : fmtNumber(leg.gridDistance, 3),
      geodesic: leg.geodesicDistance === null ? '—' : fmtNumber(leg.geodesicDistance, 3),
      ground: leg.groundDistance === null ? '—' : fmtNumber(leg.groundDistance, 3),
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
      { key: 'gridBearing', label: 'Grid brg.', unit: '°' },
      { key: 'azimuth', label: 'Azimuth', unit: '°' },
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
            unit="m²"
            tone={tone}
            delta={`${fmtNumber(units.ha, 4)} ha · ${fmtNumber(units.acres, 4)} ac`}
            wide
          />
          <Readout label="Perimeter" value={fmtNumber(surface.perimeter, 3)} unit="m" />
          <Readout label="Hectares" value={fmtNumber(units.ha, 4)} unit="ha" />
          <Readout label="Acres" value={fmtNumber(units.acres, 4)} unit="ac" />
        </ReadoutGrid>
        {key === 'ground' && result.csf !== null ? (
          <p className="tool-hint">
            Ground surface = grid ÷ CSF² with CSF {fmtNumber(result.csf, 8)} (projection k{' '}
            {fmtNumber(result.projectScaleFactor ?? Number.NaN, 8)} × elevation factor{' '}
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
      { label: 'Ring', value: 'auto-closed (last → first)' },
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
            'Geodesia — Polygon Area',
            `Reference system: ${mode === 'xy' ? 'Local X/Y' : mode === 'utm' ? `UTM ${zoneText}${hemisphere}` : `Geographic (auto UTM ${result.zone ?? ''}${result.hemisphere ?? ''})`}`,
            `Grid area: ${fmtNumber(result.grid.area, 2)} m2 · perimeter ${fmtNumber(result.grid.perimeter, 3)} m`,
            `Geodesic area: ${result.geodesic ? `${fmtNumber(result.geodesic.area, 2)} m2 · perimeter ${fmtNumber(result.geodesic.perimeter, 3)} m` : 'n/a'}`,
            `Ground area: ${result.ground ? `${fmtNumber(result.ground.area, 2)} m2 · perimeter ${fmtNumber(result.ground.perimeter, 3)} m` : 'n/a'}`,
            `CSF: ${result.csf === null ? 'n/a' : fmtNumber(result.csf, 8)} · mean elevation ${fmtNumber(useGround ? meanElevation : 0, 3)} m`,
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
                'Gaussian shoelace on projected UTM grid coordinates; Karney ellipsoidal geodesic area/perimeter on WGS 84; ground surface via combined scale factor (k · EF)',
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
            subtitle: `${fmtNumber(result.vertexCount, 0)} vertices · ${mode === 'xy' ? 'Local X/Y grid' : mode === 'utm' ? `UTM ${zoneText}${hemisphere}` : 'Geographic (auto UTM)'}`,
            parameters: parameters(),
            notes: [
              'Grid area uses the Gaussian shoelace on projected coordinates (ring translated to its first vertex).',
              'Geodesic area/perimeter use the WGS 84 ellipsoid (Karney), never a sphere approximation.',
              'Ground distance = grid distance ÷ CSF; ground area = grid area ÷ CSF².',
              ...result.warnings,
            ],
          },
          sections: [
            {
              kind: 'kv',
              heading: 'Grid surface',
              rows: [
                { label: 'Grid area', value: `${fmtNumber(result.grid.area, 2)} m²`, emphasis: true },
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
                { label: 'Closure (last → first)', value: `${fmtNumber(result.closure, 3)} m` },
              ],
            },
            ...(result.geodesic
              ? [
                  {
                    kind: 'kv' as const,
                    heading: 'Geodesic surface (WGS 84)',
                    rows: [
                      { label: 'Geodesic area', value: `${fmtNumber(result.geodesic.area, 2)} m²`, emphasis: true },
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
                      { label: 'Ground area', value: `${fmtNumber(result.ground.area, 2)} m²`, emphasis: true },
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
              footnote: `Totals · grid ${fmtNumber(result.grid.perimeter, 3)} m · geodesic ${result.geodesic ? `${fmtNumber(result.geodesic.perimeter, 3)} m` : 'n/a'} · ground ${result.ground ? `${fmtNumber(result.ground.perimeter, 3)} m` : 'n/a'}`,
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

  return (
    <div className="tool">
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>

      {/* ------------------------------------------------------------- aside */}
      <div className="tool__aside">
        <Panel title="Reference system" tight>
          <Segmented options={modeOptions} value={mode} onChange={switchMode} label="Reference system" />
          <p className="tool-hint">{MODE_HINTS[mode]}</p>
          {mode === 'utm' ? (
            <div className="field-row">
              <Field label="UTM zone" htmlFor={zoneId} hint="1–60">
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
            <Readout
              label="Auto UTM zone"
              value={zoneLabel}
              delta="derived from the centroid"
              tone="default"
            />
          ) : null}
        </Panel>

        <Panel title="Surfaces & scale" tight>
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
              <span className="check__note">grid ÷ CSF and grid ÷ CSF²</span>
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
              Local X/Y has no geographic reference, so only the grid surface can be computed.
            </Notice>
          ) : null}
          {result ? (
            <div className="formula">
              <p className="formula__name">Combined scale factor</p>
              <p className="formula__body">
                CSF = k · EF &nbsp;·&nbsp; k = k₀(1 + x²/2R²) &nbsp;·&nbsp; EF = a/(a+h)
              </p>
              <p className="formula__note">
                k₀ = 0.9996, x = meanE − 500 000 m, R = √(M·N) at the centroid latitude. Ground
                distance = grid ÷ CSF; ground area = grid ÷ CSF². {result.csf === null ? 'CSF is not applicable for this input.' : `Computed CSF ${fmtNumber(result.csf, 8)}.`}
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel title="Vertices input" tight>
          <Field
            label="Paste coordinates"
            htmlFor={pasteId}
            hint={
              mode === 'xy'
                ? 'One “X, Y” pair per line (metres)'
                : mode === 'utm'
                  ? 'One “E, N” pair per line (metres)'
                  : 'One “Lon, Lat” pair per line — decimal or DMS'
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
            <button type="button" className="btn btn--sm" onClick={applyPaste} disabled={!pasteText.trim()}>
              <IconGrid size={14} /> Load vertices
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
                {importBusy ? 'Reading vertices…' : 'Drop CSV, TXT or XLSX'}
              </span>
              <span className="dropzone__hint">
                two coordinate columns ·{' '}
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
              Imported <strong>{importedName}</strong> — check the reference system and column order.
            </p>
          ) : null}
          {importWarning ? <Notice tone="warn">{importWarning}</Notice> : null}
          {importError ? <Notice tone="err">{importError}</Notice> : null}
        </Panel>

        <Panel
          title="Compute"
          meta={dirty && result ? 'inputs changed' : result ? 'up to date' : 'not computed'}
          tight
          footer={
            <span className="panel__meta">
              Zone {zoneLabel} · {fmtNumber(rows.length, 0)} vertices
            </span>
          }
        >
          {computeError ? <Notice tone="err">{computeError}</Notice> : null}
          {validationIssues.length > 0 ? (
            <Notice tone="err" title="Validation failed">
              <ul className="issue-list">
                {validationIssues.map((issue, index) => (
                  <li key={`issue-${index}`}>{issue}</li>
                ))}
              </ul>
            </Notice>
          ) : null}
          {dirty && result ? (
            <Notice tone="info">Inputs changed — run the computation again to refresh the results.</Notice>
          ) : null}
          <button
            type="button"
            className="btn btn--primary btn--block"
            onClick={() => void runCompute()}
            disabled={computing}
          >
            <IconCrosshair size={15} /> {computing ? 'Computing…' : 'Execute computation'}
          </button>
          {basemap ? (
            <p className="tool-hint">
              Basemap: {basemap.label}
              {basemap.status === 'failed'
                ? ' — map unavailable, coordinate entry and tables still work.'
                : basemap.status === 'fallback'
                  ? ' (fallback source)'
                  : ''}
            </p>
          ) : null}
        </Panel>
      </div>

      {/* -------------------------------------------------------------- main */}
      <div className="tool__main">
        {mode !== 'latlon' ? (
          <Panel
            title={mode === 'xy' ? 'Coordinate sheet' : 'Grid coordinate sheet'}
            meta={mode === 'xy' ? 'local X/Y · metres' : `UTM ${zoneText}${hemisphere} · metres`}
            tight
          >
            <PlotSurface
              vertices={plotVertices.map((vertex, index) => ({ ...vertex, label: fmtNumber(index + 1, 0) }))}
              centroid={centroidGrid ? { x: centroidGrid.E, y: centroidGrid.N } : null}
              legDistances={plotLegDistances}
              areaM2={result?.grid.area ?? null}
              perimeterM={result?.grid.perimeter ?? null}
              axisLabels={mode === 'xy' ? { x: 'X (m)', y: 'Y (m)' } : { x: 'E (m)', y: 'N (m)' }}
              northLabel={mode === 'xy' ? 'Y' : 'N'}
              title={mode === 'xy' ? 'Local grid plot' : 'UTM grid plot'}
            />
          </Panel>
        ) : null}

        {mode !== 'xy' ? (
          <Panel
            title={mode === 'latlon' ? 'Parcel map' : 'Map overlay'}
            meta={
              mode === 'latlon'
                ? `${fmtNumber(geoPoints.length, 0)} vertices · click map to add`
                : 'grid ring projected to WGS 84'
            }
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
            tight
          >
            <MapCanvas
              mode={mode === 'latlon' ? 'polygon' : 'view'}
              center={MAP_DEFAULT_VIEW.center}
              zoom={MAP_DEFAULT_VIEW.zoom}
              markers={mapMarkers}
              polygon={mapPolygon}
              line={mapLine}
              onMapClick={mode === 'latlon' ? handleMapClick : undefined}
              onMapError={setMapError}
              onBasemapChange={handleBasemap}
              onReady={handleMapReady}
              ariaLabel={
                mode === 'latlon'
                  ? 'Parcel map: click to add vertices in ring order'
                  : 'UTM parcel overlay map'
              }
            >
              <div className="map-overlay map-overlay--bl">
                <p className="map-hint">
                  {mode === 'latlon' ? (
                    <>
                      <strong>Click the map to add vertices</strong> in ring order (Lon, Lat is written
                      to the table). The ring closes automatically from the last vertex to the first.
                    </>
                  ) : (
                    <>
                      <strong>Grid ring projected to lon/lat</strong> with the entered zone and
                      hemisphere. Edit E/N in the table or paste; the map is a spatial check, not an
                      input.
                    </>
                  )}
                </p>
              </div>
            </MapCanvas>
            {mapError ? (
              <Notice tone="warn" title="Map unavailable">
                {mapError} The white coordinate sheet and the vertex table still work — the parcel can
                be entered, computed and exported without the basemap.
              </Notice>
            ) : null}
            {mode === 'utm' && utmEngineReady && geoPoints.length === 0 && parsed.points.length > 0 ? (
              <Notice tone="warn">
                The ring could not be projected for the map overlay. Check the UTM zone and hemisphere
                — grid results are unaffected.
              </Notice>
            ) : null}
            {utmEngineError ? (
              <Notice tone="warn" title="Projection engine unavailable">
                {utmEngineError} Grid results for UTM and geographic input need this engine; the
                values already computed remain valid, and a reload retries the download.
              </Notice>
            ) : null}
          </Panel>
        ) : null}

        <Panel
          title="Vertices"
          meta={`${fmtNumber(rows.length, 0)} vertices · auto-closed`}
          actions={
            <Toolbar label="Vertex row actions">
              <button type="button" className="btn btn--sm" onClick={addRow}>
                <IconPlus size={14} /> Add vertex
              </button>
              <button type="button" className="btn btn--sm btn--quiet" onClick={clearRows} disabled={rows.length === 0}>
                <IconTrash size={14} /> Clear
              </button>
            </Toolbar>
          }
          tight
        >
          {rows.length === 0 ? (
            <EmptyState
              icon={<IconPolygon size={22} />}
              title="No vertices yet"
              action={
                <div className="btn-row">
                  <button type="button" className="btn btn--sm btn--primary" onClick={addRow}>
                    <IconPlus size={14} /> Add first vertex
                  </button>
                  <button type="button" className="btn btn--sm" onClick={loadSample}>
                    Load example parcel
                  </button>
                </div>
              }
            >
              {mode === 'latlon'
                ? 'Click the map to add vertices, paste a Lon, Lat list, or add rows manually.'
                : 'Add rows manually or paste a coordinate list in the expected column order.'}
            </EmptyState>
          ) : (
            <>
              {invalidCount > 0 ? (
                <Notice tone="warn">
                  {fmtNumber(invalidCount, 0)} row{invalidCount === 1 ? '' : 's'} cannot be read yet.
                  Complete or remove {invalidCount === 1 ? 'it' : 'them'} to compute results.
                </Notice>
              ) : null}
              {mode === 'latlon' && parsed.swapSuspected ? (
                <Notice
                  tone={parsed.swapSuspected === 'strong' ? 'err' : 'warn'}
                  title={parsed.swapSuspected === 'strong' ? 'Columns look swapped' : 'Check column order'}
                  action={
                    <button type="button" className="btn btn--sm" onClick={swapColumns}>
                      Swap to Lon, Lat
                    </button>
                  }
                >
                  This calculator expects <strong>Lon, Lat</strong> order. These values look like
                  Lat, Lon — if the map or results are displaced, swap the columns.
                </Notice>
              ) : null}
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
              <p className="tool-hint">
                The ring closes automatically from the last vertex back to the first — do not repeat
                the first vertex. Current order:{' '}
                {mode === 'xy' ? 'X, Y' : mode === 'utm' ? 'E, N' : 'Lon, Lat'}.
              </p>
            </>
          )}
        </Panel>

        {result ? (
          <>
            <div className="surface-cards">
              {surfaceCard('grid', 'Grid', 'accent')}
              {surfaceCard('geodesic', 'Geodesic', 'default')}
              {surfaceCard('ground', 'Ground', 'default')}
            </div>

            <Panel title="Ring diagnostics" meta={`${fmtNumber(result.vertexCount, 0)} vertices`}>
              <ReadoutGrid label="Closure, centroid and scale factors">
                <Readout
                  label="Closure (last → first)"
                  value={fmtNumber(result.closure, 3)}
                  unit="m"
                  delta="auto-close leg"
                />
                <Readout label="UTM zone" value={zoneLabel} delta={result.zoneAuto ? 'auto from centroid' : 'user supplied'} />
                <Readout
                  label="Centroid E"
                  value={centroidGrid ? fmtNumber(centroidGrid.E, 3) : '—'}
                  unit={centroidGrid ? 'm' : undefined}
                />
                <Readout
                  label="Centroid N"
                  value={centroidGrid ? fmtNumber(centroidGrid.N, 3) : '—'}
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
                  value={result.projectScaleFactor === null ? '—' : fmtNumber(result.projectScaleFactor, 8)}
                  delta="k = k₀(1 + x²/2R²)"
                />
                <Readout
                  label="Elevation factor"
                  value={result.elevationFactor === null ? '—' : fmtNumber(result.elevationFactor, 8)}
                  delta="EF = a/(a+h)"
                />
                <Readout
                  label="CSF"
                  value={result.csf === null ? '—' : fmtNumber(result.csf, 8)}
                  delta={csfOverride !== null ? 'user override' : 'k × EF'}
                />
              </ReadoutGrid>
              {result.selfIntersecting ? (
                <Notice tone="err" title="Self-intersecting ring">
                  The boundary crosses itself (bow-tie). Grid/geodesic/ground areas are still shown
                  for diagnosis, but a survey cannot use a self-intersecting parcel — reorder or move
                  the crossing vertices.
                </Notice>
              ) : null}
              {result.warnings.length > 0 ? (
                <div className="stack stack--sm">
                  {result.warnings.map((warning, index) => (
                    <Notice key={`warning-${index}`} tone="warn">
                      {warning}
                    </Notice>
                  ))}
                </div>
              ) : null}
              {exportError ? <Notice tone="err">{exportError}</Notice> : null}
              <div className="btn-row">
                <button type="button" className="btn btn--sm" onClick={() => void runExport('csv')} disabled={exporting !== null}>
                  <IconDownload size={14} /> {exporting === 'csv' ? 'CSV…' : 'CSV'}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => void runExport('json')} disabled={exporting !== null}>
                  <IconDownload size={14} /> {exporting === 'json' ? 'JSON…' : 'JSON'}
                </button>
                <button type="button" className="btn btn--sm" onClick={() => void runExport('pdf')} disabled={exporting !== null}>
                  <IconDownload size={14} /> {exporting === 'pdf' ? 'PDF…' : 'PDF'}
                </button>
              </div>
            </Panel>

            <Panel title="Vector legs" meta={`${fmtNumber(legRows.length, 0)} legs · auto-closed`} tight>
              <DataTable
                columns={legColumns}
                rows={legRows}
                rowKey={(row) => row.key}
                caption="Polygon legs: grid distance, geodesic distance, ground distance, grid bearing and azimuth."
                footer={[
                  'Σ',
                  '',
                  '',
                  fmtNumber(result.grid.perimeter, 3),
                  result.geodesic ? fmtNumber(result.geodesic.perimeter, 3) : '—',
                  result.ground ? fmtNumber(result.ground.perimeter, 3) : '—',
                  '',
                  '',
                ]}
                empty={<EmptyState title="No legs">Add at least three vertices and compute.</EmptyState>}
              />
              <p className="tool-hint">
                Totals row: grid perimeter {fmtNumber(result.grid.perimeter, 3)} m
                {result.geodesic ? ` · geodesic ${fmtNumber(result.geodesic.perimeter, 3)} m` : ''}
                {result.ground ? ` · ground ${fmtNumber(result.ground.perimeter, 3)} m` : ''}. Bearings
                are clockwise from grid north; azimuths are forward azimuths on WGS 84.
              </p>
            </Panel>
          </>
        ) : (
          <Panel title="Results" meta="Awaiting computation">
            <EmptyState icon={<IconGrid size={22} />} title="No results yet">
              Enter or click at least three vertices, then run the computation. Grid, geodesic and
              ground surfaces appear here with closure, centroid and the per-leg vector table.
            </EmptyState>
            {computeError ? <Notice tone="err">{computeError}</Notice> : null}
          </Panel>
        )}
      </div>
    </div>
  );
}
