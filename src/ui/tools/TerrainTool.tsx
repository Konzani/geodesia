/**
 * GEODESIA — Terrain Profile instrument (the default workspace view).
 *
 * Three input paths, all client-side:
 *   1. two map clicks → WGS 84 geodesic line;
 *   2. a clicked vertex route (or freehand drag) on the map;
 *   3. an uploaded CSV / TXT / TSV / XLSX table (distance+elevation or lat/lon+elevation).
 *
 * Elevations come from the Open-Meteo elevation API (batched, cached, retried)
 * with an explicit, designed failure state that keeps uploaded data usable.
 * Every rendered number goes through `src/math/format`; heavy libraries are
 * never imported here (map = dynamic import in MapCanvas, xlsx = dynamic import
 * inside math/parse, pdf-lib = lazy inside exports).
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { LatLon, TerrainResult, TerrainSample } from '../../math/types';
import {
  TERRAIN_THRESHOLDS,
  buildProfileFromPath,
  computeTerrainProfile,
  fmtLength,
  fmtNumber,
  fmtSigned,
  geodesicInverse,
  geodesicPath,
  geodesicPolylinePath,
  ingestTerrainRows,
  parseDMS,
  parseDelimitedText,
  parseSpreadsheet,
} from '../../math';
import { buildVerification, exportCSV, exportFilename, exportJSON, exportPDF, timestamp } from '../../exports';
import type { PdfReportSpec } from '../../exports/types';
import {
  Badge,
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
import type { BadgeTone, DataTableColumn } from '../components/ui';
import { MapCanvas } from './MapCanvas';
import type { MapCanvasApi, MapMarker } from './MapCanvas';
import { ProfileChart } from './ProfileChart';
import { fetchElevations } from './elevation';
import {
  IconCrosshair,
  IconDownload,
  IconFile,
  IconRefresh,
  IconRoute,
  IconTerrain,
  IconTrash,
  IconUpload,
} from './icons';
import {
  cx,
  errorMessage,
  fillMissingElevations,
  formatFileSize,
  isAbortError,
  readFileAsArrayBuffer,
  readFileAsText,
} from './utils';

type InputMode = 'points' | 'route' | 'upload';
type Smoothing = 'off' | 'light' | 'medium';
type Phase = 'idle' | 'fetching' | 'ready' | 'error';
type ExportKind = 'csv' | 'json' | 'pdf';

interface UploadedFile {
  name: string;
  size: number;
  rows: number;
}

interface StationRow {
  key: string;
  station: string;
  chainage: string;
  elevation: string;
  delta: string;
  slopePct: string;
  slopeDeg: string;
  bearing: string;
  latitude: string;
  longitude: string;
}

const DEFAULT_CENTER: LatLon = { lat: -1.2864, lon: 36.8172 };
const DEFAULT_ZOOM = 12;
const SAMPLE_MIN = 20;
const SAMPLE_MAX = 200;
const DEFAULT_SAMPLES = 64;
const TABLE_ROW_LIMIT = 250;
/** Stable empty array so the chart's reset effect does not fire on idle renders. */
const EMPTY_SAMPLES: TerrainSample[] = [];

const inputModes: ReadonlyArray<{ value: InputMode; label: string }> = [
  { value: 'points', label: 'Two points' },
  { value: 'route', label: 'Route' },
  { value: 'upload', label: 'Upload' },
];

const smoothingOptions: ReadonlyArray<{ value: Smoothing; label: string }> = [
  { value: 'off', label: 'Off' },
  { value: 'light', label: 'Light' },
  { value: 'medium', label: 'Medium' },
];

function categoryTone(category: TerrainResult['category']): BadgeTone {
  switch (category) {
    case 'Flat':
    case 'Gentle':
      return 'client';
    case 'Rolling':
      return 'default';
    case 'Hilly':
    case 'Steep':
      return 'beta';
    default:
      return 'default';
  }
}

function normalizedBearing(azimuth: number): number {
  return ((azimuth % 360) + 360) % 360;
}

function parseCoordinate(value: string, limit: number): number | null {
  const parsed = parseDMS(value.trim());
  if (parsed === null || !Number.isFinite(parsed) || Math.abs(parsed) > limit) return null;
  return parsed;
}

function parseVertexLines(text: string): LatLon[] {
  const points: LatLon[] = [];
  const lines = text.split(/\r?\n/);
  const errors: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parts = trimmed.split(/[,\s;]+/).filter(Boolean);
    if (parts.length < 2) {
      errors.push(index + 1);
      return;
    }
    const lat = parseCoordinate(parts[0], 90);
    const lon = parseCoordinate(parts[1], 180);
    if (lat === null || lon === null) {
      errors.push(index + 1);
      return;
    }
    points.push({ lat, lon });
  });
  if (errors.length > 0) {
    throw new Error(`Could not read coordinates on line ${errors.slice(0, 4).join(', ')}.`);
  }
  if (points.length < 2) {
    throw new Error('Paste at least two vertices, one “lat, lon” pair per line.');
  }
  return points;
}

export default function TerrainTool() {
  /* ---------------------------------------------------------------- input */
  const [inputMode, setInputMode] = useState<InputMode>('points');
  const [start, setStart] = useState<LatLon | null>(null);
  const [end, setEnd] = useState<LatLon | null>(null);
  const [route, setRoute] = useState<LatLon[]>([]);
  const [freehand, setFreehand] = useState(false);
  const [routeText, setRouteText] = useState('');
  const [routeError, setRouteError] = useState<string | null>(null);

  const [coordA, setCoordA] = useState({ lat: '', lon: '' });
  const [coordB, setCoordB] = useState({ lat: '', lon: '' });
  const [coordError, setCoordError] = useState<string | null>(null);

  /* ------------------------------------------------------------- sampling */
  const [sampleCount, setSampleCount] = useState(DEFAULT_SAMPLES);
  const [sampleInput, setSampleInput] = useState(String(DEFAULT_SAMPLES));
  const [smoothing, setSmoothing] = useState<Smoothing>('off');

  /* --------------------------------------------------------------- upload */
  const [uploaded, setUploaded] = useState<UploadedFile | null>(null);
  const [uploadBusy, setUploadBusy] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  /* -------------------------------------------------------------- results */
  const [rawSamples, setRawSamples] = useState<TerrainSample[] | null>(null);
  const [positions, setPositions] = useState<LatLon[]>([]);
  const [sourceLabel, setSourceLabel] = useState('No profile yet');
  const [phase, setPhase] = useState<Phase>('idle');
  const [fetchProgress, setFetchProgress] = useState<{ completed: number; total: number } | null>(null);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [mapError, setMapError] = useState<string | null>(null);
  const [retryToken, setRetryToken] = useState(0);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const fitRef = useRef<((points: ReadonlyArray<LatLon>) => void) | null>(null);
  const [mapApiReady, setMapApiReady] = useState(false);
  const lastFitKeyRef = useRef('');
  const fileInputId = useId();
  const samplesInputId = useId();

  const smoothingWindow = smoothing === 'off' ? 0 : smoothing === 'light' ? 3 : 5;

  const profile = useMemo<TerrainResult | null>(
    () => (rawSamples ? computeTerrainProfile(rawSamples, { smoothingWindow }) : null),
    [rawSamples, smoothingWindow],
  );

  /* -------------------------------------------------------- path building */
  const mapPath = useMemo<{ points: LatLon[]; label: string } | null>(() => {
    if (inputMode === 'points') {
      if (!start || !end) return null;
      return {
        points: geodesicPath(start, end, sampleCount),
        label: 'Geodesic line A → B',
      };
    }
    if (inputMode === 'route') {
      if (route.length < 2) return null;
      const sampled = geodesicPolylinePath(route, sampleCount);
      return {
        points: sampled.points,
        label: `Route · ${fmtNumber(route.length, 0)} vertices`,
      };
    }
    return null;
  }, [inputMode, start, end, route, sampleCount]);

  const resetResults = useCallback(() => {
    setRawSamples(null);
    setPositions([]);
    setPhase('idle');
    setFetchProgress(null);
    setFetchError(null);
    setWarnings([]);
    setSourceLabel('No profile yet');
  }, []);

  /* ----------------------------------------------------- elevation fetch */
  useEffect(() => {
    if (inputMode === 'upload') return;
    if (!mapPath) {
      resetResults();
      return;
    }

    let cancelled = false;
    const controller = new AbortController();
    const pathPoints = mapPath.points;

    setPhase('fetching');
    setFetchError(null);
    setWarnings([]);
    setRawSamples(null);
    setFetchProgress({ completed: 0, total: pathPoints.length });
    setPositions(pathPoints);
    setSourceLabel(mapPath.label);

    void (async () => {
      try {
        const result = await fetchElevations(pathPoints, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!cancelled) setFetchProgress({ completed: progress.completed, total: progress.total });
          },
        });
        if (cancelled) return;

        const { values, filled } = fillMissingElevations(result.elevations);
        const samples = buildProfileFromPath(pathPoints, values);
        const finalSample = samples[samples.length - 1];
        const nextWarnings: string[] = [];
        if (filled > 0) {
          nextWarnings.push(
            `${fmtNumber(filled, 0)} of ${fmtNumber(pathPoints.length, 0)} sample elevations were unavailable and have been interpolated between neighbouring stations.`,
          );
        }
        if (result.failedBatches > 0) {
          nextWarnings.push(
            `${fmtNumber(result.failedBatches, 0)} elevation request${result.failedBatches === 1 ? '' : 's'} failed after retries.`,
          );
        }
        if (cancelled) return;

        setRawSamples(samples);
        setWarnings(nextWarnings);
        setPhase('ready');
        setStatusMessage(
          `Profile ready: ${fmtNumber(samples.length, 0)} stations over ${fmtLength(finalSample?.distance ?? 0, 'km')}.`,
        );
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        setRawSamples(null);
        setPhase('error');
        setFetchError(errorMessage(error));
        setStatusMessage('Elevation lookup failed. Uploaded data and coordinate entry are still available.');
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
    // `smoothingWindow` intentionally excluded: it recomputes from raw samples.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapPath, inputMode, retryToken, resetResults]);

  /* --------------------------------------------------------- map markers */
  const markers = useMemo<MapMarker[]>(() => {
    if (inputMode === 'points') {
      const list: MapMarker[] = [];
      if (start) list.push({ lat: start.lat, lon: start.lon, kind: 'start', label: 'A' });
      if (end) list.push({ lat: end.lat, lon: end.lon, kind: 'end', label: 'B' });
      return list;
    }
    if (inputMode === 'route') {
      return route.map((point, index) => ({
        lat: point.lat,
        lon: point.lon,
        kind: 'vertex',
        label:
          route.length > 1 && index === 0
            ? 'A'
            : route.length > 1 && index === route.length - 1
              ? 'B'
              : undefined,
      }));
    }
    if (positions.length > 1) {
      return [
        { ...positions[0], kind: 'start', label: 'A' },
        { ...positions[positions.length - 1], kind: 'end', label: 'B' },
      ];
    }
    return [];
  }, [inputMode, start, end, route, positions]);

  const mapLine = useMemo<ReadonlyArray<LatLon> | undefined>(() => {
    if (inputMode === 'upload') return positions.length > 1 ? positions : undefined;
    return mapPath && mapPath.points.length > 1 ? mapPath.points : undefined;
  }, [inputMode, positions, mapPath]);

  /* --------------------------------------------------- fit view on changes */
  useEffect(() => {
    if (inputMode !== 'points' || !start || !end) return;
    const key = `${start.lat.toFixed(6)},${start.lon.toFixed(6)}|${end.lat.toFixed(6)},${end.lon.toFixed(6)}`;
    if (key === lastFitKeyRef.current) return;
    lastFitKeyRef.current = key;
    fitRef.current?.([start, end]);
  }, [mapApiReady, inputMode, start, end]);

  /* ------------------------------------------------------- map callbacks */
  const handleMapClick = useCallback(
    (point: LatLon) => {
      if (inputMode === 'points') {
        if (!start || (start && end)) {
          setStart(point);
          setEnd(null);
          setCoordA({ lat: fmtNumber(point.lat, 6), lon: fmtNumber(point.lon, 6) });
          setCoordB({ lat: '', lon: '' });
          setStatusMessage('Point A set. Click the map again to set point B.');
        } else {
          setEnd(point);
          setCoordB({ lat: fmtNumber(point.lat, 6), lon: fmtNumber(point.lon, 6) });
          setStatusMessage('Point B set. Computing the geodesic line.');
        }
        return;
      }
      if (inputMode === 'route') {
        setRoute((previous) => [...previous, point]);
        setStatusMessage(`Route vertex ${fmtNumber(route.length + 1, 0)} added.`);
      }
    },
    [inputMode, start, end, route.length],
  );

  const handleStrokeDrawn = useCallback((points: LatLon[]) => {
    setRoute(points);
    setStatusMessage(`Freehand route captured with ${fmtNumber(points.length, 0)} vertices.`);
    fitRef.current?.(points);
  }, []);

  const handleMapError = useCallback((message: string) => {
    setMapError(message);
  }, []);

  const handleMapReady = useCallback((api: MapCanvasApi) => {
    fitRef.current = api.fit;
    setMapApiReady(true);
  }, []);

  /* -------------------------------------------------------- mode changes */
  const switchInputMode = (mode: InputMode) => {
    if (mode === inputMode) return;
    setInputMode(mode);
    resetResults();
    setStatusMessage('');
    lastFitKeyRef.current = '';
    if (mode === 'upload') {
      setRouteError(null);
      setCoordError(null);
    }
  };

  const clearAll = () => {
    setStart(null);
    setEnd(null);
    setRoute([]);
    setUploaded(null);
    setCoordA({ lat: '', lon: '' });
    setCoordB({ lat: '', lon: '' });
    setRouteText('');
    setRouteError(null);
    setCoordError(null);
    setUploadError(null);
    setMapError(null);
    resetResults();
    lastFitKeyRef.current = '';
    setStatusMessage('Cleared.');
  };

  /* ---------------------------------------------------- manual coordinates */
  const applyCoordinates = () => {
    const latA = parseCoordinate(coordA.lat, 90);
    const lonA = parseCoordinate(coordA.lon, 180);
    const latB = parseCoordinate(coordB.lat, 90);
    const lonB = parseCoordinate(coordB.lon, 180);
    if (latA === null || lonA === null) {
      setCoordError('Point A needs a latitude within ±90° and a longitude within ±180°, decimal or DMS.');
      return;
    }
    if (latB === null || lonB === null) {
      setCoordError('Point B needs a latitude within ±90° and a longitude within ±180°, decimal or DMS.');
      return;
    }
    setCoordError(null);
    const nextStart = { lat: latA, lon: lonA };
    const nextEnd = { lat: latB, lon: lonB };
    setStart(nextStart);
    setEnd(nextEnd);
    setInputMode('points');
    lastFitKeyRef.current = '';
    setStatusMessage('Coordinates applied. Computing the geodesic line.');
  };

  const applyRouteText = () => {
    try {
      const points = parseVertexLines(routeText);
      setRoute(points);
      setRouteError(null);
      setInputMode('route');
      setStatusMessage(`Route loaded with ${fmtNumber(points.length, 0)} vertices.`);
      fitRef.current?.(points);
    } catch (error) {
      setRouteError(errorMessage(error));
    }
  };

  /* ---------------------------------------------------------- sample count */
  const applySampleCount = (raw: string) => {
    setSampleInput(raw);
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed)) return;
    setSampleCount(Math.min(SAMPLE_MAX, Math.max(SAMPLE_MIN, parsed)));
  };

  /* ---------------------------------------------------------------- upload */
  const ingestFile = async (file: File) => {
    setUploadBusy(true);
    setUploadError(null);
    setFetchError(null);
    try {
      const lower = file.name.toLowerCase();
      const data =
        lower.endsWith('.xlsx') || lower.endsWith('.xls')
          ? await parseSpreadsheet(await readFileAsArrayBuffer(file))
          : parseDelimitedText(await readFileAsText(file));
      const ingest = ingestTerrainRows(data);
      if (ingest.samples.length < 2) {
        throw new Error('The file needs at least two rows containing elevation values.');
      }
      setInputMode('upload');
      setRawSamples(ingest.samples);
      setPositions(ingest.trace);
      setUploaded({ name: file.name, size: file.size, rows: ingest.samples.length });
      setSourceLabel(`${file.name} · ${ingest.source === 'lat/lon+elevation' ? 'lat/lon + elevation' : 'distance + elevation'}`);
      setWarnings(ingest.warnings);
      setPhase('ready');
      setFetchProgress(null);
      setStatusMessage(`Loaded ${fmtNumber(ingest.samples.length, 0)} stations from ${file.name}.`);
      if (ingest.trace.length > 1) fitRef.current?.(ingest.trace);
    } catch (error) {
      setUploaded(null);
      setUploadError(errorMessage(error));
      setPhase('idle');
      setStatusMessage('Could not read the uploaded file.');
    } finally {
      setUploadBusy(false);
    }
  };

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void ingestFile(file);
  };

  const handleDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) void ingestFile(file);
  };

  /* --------------------------------------------------------------- export */
  const stationRows = useMemo<StationRow[]>(() => {
    if (!profile) return [];
    const { samples, segments } = profile;
    const useSegments = segments.length === samples.length - 1;
    return samples.map((sample, index) => {
      const previous = index > 0 ? samples[index - 1] : null;
      const segment = useSegments && index > 0 ? segments[index - 1] : null;
      const run = previous ? sample.distance - previous.distance : 0;
      const rise = previous ? sample.elevation - previous.elevation : 0;
      const localPct = run !== 0 ? (rise / run) * 100 : 0;
      const slopePct = segment ? segment.slopePct : localPct;
      const slopeDeg = segment ? segment.slopeDeg : Math.atan(localPct / 100) * (180 / Math.PI);
      const bearing =
        previous && positions.length === samples.length
          ? normalizedBearing(geodesicInverse(positions[index - 1], positions[index]).azi1)
          : null;
      return {
        key: `station-${index}`,
        station: String(index + 1).padStart(3, '0'),
        chainage: fmtNumber(sample.distance / 1000, 2),
        elevation: fmtNumber(sample.elevation, 1),
        delta: previous ? fmtSigned(sample.distance - previous.distance, 1) : '—',
        slopePct: index === 0 ? '—' : fmtSigned(slopePct, 1),
        slopeDeg: index === 0 ? '—' : fmtNumber(slopeDeg, 1),
        bearing: bearing === null ? '—' : fmtNumber(bearing, 1),
        latitude: sample.lat !== undefined ? fmtNumber(sample.lat, 6) : '—',
        longitude: sample.lon !== undefined ? fmtNumber(sample.lon, 6) : '—',
      };
    });
  }, [profile, positions]);

  const tableRows = useMemo(() => stationRows.slice(0, TABLE_ROW_LIMIT), [stationRows]);

  const stationColumns = useMemo<ReadonlyArray<DataTableColumn<StationRow>>>(
    () => [
      { key: 'station', label: 'Station', align: 'left' },
      { key: 'chainage', label: 'Chainage', unit: 'km' },
      { key: 'elevation', label: 'Elevation', unit: 'm' },
      { key: 'delta', label: 'Δs', unit: 'm' },
      { key: 'slopePct', label: 'Slope', unit: '%' },
      { key: 'slopeDeg', label: 'Slope', unit: '°' },
      { key: 'bearing', label: 'Bearing', unit: '°' },
      { key: 'latitude', label: 'Latitude', unit: '°' },
      { key: 'longitude', label: 'Longitude', unit: '°' },
    ],
    [],
  );

  const exportParameters = (): Array<{ label: string; value: string | number }> => {
    if (!profile) return [];
    return [
      { label: 'Source', value: sourceLabel },
      { label: 'Stations', value: profile.samples.length },
      { label: 'Sampling', value: `${fmtNumber(sampleCount, 0)} stations` },
      { label: 'Smoothing', value: smoothing === 'off' ? 'None' : `${smoothingWindow}-sample moving average` },
      { label: 'Datum', value: 'WGS 84' },
    ];
  };

  const profileMetrics = (): Array<{ label: string; value: string }> => {
    if (!profile) return [];
    return [
      { label: 'Distance', value: fmtLength(profile.distance, 'km') },
      { label: 'Elevation gain', value: `${fmtNumber(profile.gain, 1)} m` },
      { label: 'Descent', value: `${fmtNumber(profile.descent, 1)} m` },
      { label: 'Net change', value: `${fmtSigned(profile.net, 1)} m` },
      { label: 'Minimum', value: `${fmtNumber(profile.min, 1)} m` },
      { label: 'Maximum', value: `${fmtNumber(profile.max, 1)} m` },
      { label: 'Range', value: `${fmtNumber(profile.range, 1)} m` },
      { label: 'Mean elevation', value: `${fmtNumber(profile.meanElevation, 1)} m` },
      { label: 'Average grade', value: `${fmtNumber(profile.avgSlopePct, 1)} %` },
      { label: 'Maximum grade', value: `${fmtNumber(profile.maxSlopePct, 1)} % / ${fmtNumber(profile.maxSlopeDeg, 1)}°` },
      { label: 'Terrain category', value: profile.category },
    ];
  };

  /**
   * Raw numeric results for the JSON verification artefact. Formats are only
   * added under `formatted` so the verification document stays machine-checkable
   * under `geodesia.report/v1`.
   */
  const rawProfileResults = () => {
    if (!profile) return null;
    const { samples, segments } = profile;
    const useSegments = segments.length === samples.length - 1;
    return {
      distanceM: profile.distance,
      gainM: profile.gain,
      descentM: profile.descent,
      netM: profile.net,
      minElevationM: profile.min,
      maxElevationM: profile.max,
      rangeM: profile.range,
      meanElevationM: profile.meanElevation,
      startElevationM: profile.startElevation,
      endElevationM: profile.endElevation,
      avgGradePct: profile.avgSlopePct,
      maxGradePct: profile.maxSlopePct,
      maxGradeDeg: profile.maxSlopeDeg,
      maxGradeAtM: profile.maxSlopeAt,
      category: profile.category,
      stationCount: samples.length,
      stations: samples.map((sample, index) => {
        const previous = index > 0 ? samples[index - 1] : null;
        const segment = useSegments && index > 0 ? segments[index - 1] : null;
        const bearing =
          previous && positions.length === samples.length
            ? normalizedBearing(geodesicInverse(positions[index - 1], positions[index]).azi1)
            : null;
        return {
          station: index + 1,
          chainageM: sample.distance,
          elevationM: sample.elevation,
          deltaDistanceM: previous ? sample.distance - previous.distance : null,
          slopePct: segment ? segment.slopePct : null,
          slopeDeg: segment ? segment.slopeDeg : null,
          bearingDeg: bearing,
          lat: sample.lat ?? null,
          lon: sample.lon ?? null,
        };
      }),
      trace: positions.map((point) => ({ lat: point.lat, lon: point.lon })),
    };
  };

  const runExport = async (kind: ExportKind) => {
    if (!profile) return;
    setExporting(kind);
    setExportError(null);
    try {
      const slug = 'terrain-profile';
      if (kind === 'csv') {
        const columns = [
          { key: 'station', label: 'Station' },
          { key: 'chainage', label: 'Chainage', unit: 'km' },
          { key: 'elevation', label: 'Elevation', unit: 'm' },
          { key: 'delta', label: 'Delta s', unit: 'm' },
          { key: 'slopePct', label: 'Slope', unit: '%' },
          { key: 'slopeDeg', label: 'Slope', unit: 'deg' },
          { key: 'bearing', label: 'Bearing', unit: 'deg' },
          { key: 'latitude', label: 'Latitude', unit: 'deg' },
          { key: 'longitude', label: 'Longitude', unit: 'deg' },
        ];
        exportCSV(
          exportFilename(slug, 'csv'),
          columns,
          stationRows.map((row) => ({
            station: row.station,
            chainage: row.chainage,
            elevation: row.elevation,
            delta: row.delta,
            slopePct: row.slopePct,
            slopeDeg: row.slopeDeg,
            bearing: row.bearing,
            latitude: row.latitude,
            longitude: row.longitude,
          })),
          [
            'Geodesia — Terrain Profile',
            `Source: ${sourceLabel}`,
            `Generated: ${timestamp()}`,
            'Method: WGS 84 geodesic line sampling; elevations from Open-Meteo',
          ],
        );
      } else if (kind === 'json') {
        exportJSON(
          exportFilename(slug, 'json'),
          buildVerification(
            {
              tool: 'Terrain Profile',
              title: 'Terrain elevation profile',
              method: 'WGS 84 geodesic line sampling; Open-Meteo elevation service',
              parameters: Object.fromEntries(exportParameters().map((entry) => [entry.label, entry.value])),
              notes: warnings,
            },
            {
              ...(rawProfileResults() ?? {}),
              formattedMetrics: profileMetrics(),
            },
          ),
        );
      } else {
        const spec: PdfReportSpec = {
          meta: {
            tool: 'Terrain Profile',
            title: 'Terrain elevation profile',
            subtitle: sourceLabel,
            parameters: exportParameters(),
            notes: [
              'Elevations are sourced from the Open-Meteo elevation API and are indicative, not survey-grade.',
              ...warnings,
            ],
          },
          sections: [
            { kind: 'kv', heading: 'Profile metrics', rows: profileMetrics() },
            {
              kind: 'table',
              heading: 'Station table',
              columns: [
                { label: 'Station', align: 'left' },
                { label: 'Chainage', unit: 'km', align: 'right' },
                { label: 'Elevation', unit: 'm', align: 'right' },
                { label: 'Delta s', unit: 'm', align: 'right' },
                { label: 'Slope', unit: '%', align: 'right' },
                { label: 'Slope', unit: 'deg', align: 'right' },
                { label: 'Bearing', unit: 'deg', align: 'right' },
              ],
              rows: stationRows.map((row) => [
                row.station,
                row.chainage,
                row.elevation,
                row.delta,
                row.slopePct,
                row.slopeDeg,
                row.bearing,
              ]),
              footnote: `${fmtNumber(stationRows.length, 0)} stations · WGS 84`,
            },
            {
              kind: 'notes',
              heading: 'Method',
              lines: [
                'Distance is measured along the WGS 84 geodesic using the Karney inverse solution.',
                'Elevation gain and descent are accumulated over the sampled profile.',
                'Slope is expressed as percent grade and degrees; negative values indicate descent.',
              ],
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
  const hasInput =
    inputMode === 'points'
      ? Boolean(start || end)
      : inputMode === 'route'
        ? route.length > 0
        : Boolean(uploaded);

  const clearMap = () => {
    if (inputMode === 'points') {
      setStart(null);
      setEnd(null);
      setCoordA({ lat: '', lon: '' });
      setCoordB({ lat: '', lon: '' });
    } else if (inputMode === 'route') {
      setRoute([]);
    } else {
      setUploaded(null);
      setRawSamples(null);
      setPositions([]);
      setPhase('idle');
    }
    resetResults();
    setStatusMessage('Cleared.');
  };

  return (
    <div className="tool">
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>

      {/* ------------------------------------------------------------- aside */}
      <div className="tool__aside">
        <Panel
          title="Elevation source"
          meta={inputMode === 'upload' ? 'File' : 'Map or manual'}
          tight
        >
          <Segmented
            options={inputModes}
            value={inputMode}
            onChange={switchInputMode}
            label="Terrain input mode"
          />
          {inputMode === 'points' ? (
            <div className="stack">
              <p className="tool-hint">
                Click the map to set <strong>A</strong>, then <strong>B</strong>. Prefer typing?
                Coordinates accept decimal degrees or DMS.
              </p>
              <div className="field-row">
                <Field label="A latitude" htmlFor="terrain-a-lat" hint="e.g. -1.2864">
                  <input
                    id="terrain-a-lat"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={coordA.lat}
                    placeholder="-1.286400"
                    onChange={(event) => setCoordA((previous) => ({ ...previous, lat: event.target.value }))}
                  />
                </Field>
                <Field label="A longitude" htmlFor="terrain-a-lon" hint="e.g. 36.8172">
                  <input
                    id="terrain-a-lon"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={coordA.lon}
                    placeholder="36.817200"
                    onChange={(event) => setCoordA((previous) => ({ ...previous, lon: event.target.value }))}
                  />
                </Field>
                <Field label="B latitude" htmlFor="terrain-b-lat">
                  <input
                    id="terrain-b-lat"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={coordB.lat}
                    placeholder="-1.292100"
                    onChange={(event) => setCoordB((previous) => ({ ...previous, lat: event.target.value }))}
                  />
                </Field>
                <Field label="B longitude" htmlFor="terrain-b-lon">
                  <input
                    id="terrain-b-lon"
                    className="input"
                    type="text"
                    inputMode="decimal"
                    value={coordB.lon}
                    placeholder="36.821900"
                    onChange={(event) => setCoordB((previous) => ({ ...previous, lon: event.target.value }))}
                  />
                </Field>
              </div>
              {coordError ? <Notice tone="err">{coordError}</Notice> : null}
              <div className="btn-row">
                <button type="button" className="btn btn--sm" onClick={applyCoordinates}>
                  <IconCrosshair size={14} /> Apply coordinates
                </button>
                <button type="button" className="btn btn--sm btn--quiet" onClick={clearMap} disabled={!hasInput}>
                  <IconTrash size={14} /> Clear
                </button>
              </div>
            </div>
          ) : null}

          {inputMode === 'route' ? (
            <div className="stack">
              <p className="tool-hint">
                Click the map to add route vertices (in order). Close the last leg by finishing the
                profile — the line is sampled geodesically between vertices.
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={freehand}
                  onChange={(event) => setFreehand(event.target.checked)}
                />
                <span>Freehand trace — drag on the map (mouse; taps add vertices)</span>
              </label>
              <Field
                label="Paste vertices"
                htmlFor="terrain-route-text"
                hint="One “lat, lon” pair per line; decimal or DMS. Applies all vertices."
              >
                <textarea
                  id="terrain-route-text"
                  className="textarea"
                  rows={4}
                  value={routeText}
                  placeholder={'-1.2864, 36.8172\n-1.2890, 36.8201\n-1.2921, 36.8219'}
                  onChange={(event) => setRouteText(event.target.value)}
                />
              </Field>
              {routeError ? <Notice tone="err">{routeError}</Notice> : null}
              <div className="btn-row">
                <button type="button" className="btn btn--sm" onClick={applyRouteText} disabled={!routeText.trim()}>
                  <IconRoute size={14} /> Load route
                </button>
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={() => setRoute((previous) => previous.slice(0, -1))}
                  disabled={route.length === 0}
                >
                  Remove last
                </button>
                <button type="button" className="btn btn--sm btn--quiet" onClick={clearMap} disabled={!hasInput}>
                  <IconTrash size={14} /> Clear
                </button>
              </div>
            </div>
          ) : null}

          {inputMode === 'upload' ? (
            <div className="stack">
              <div className="dropzone-wrap">
                <label
                  className={cx('dropzone', 'dropzone--compact')}
                  htmlFor={fileInputId}
                  data-dragging={dragging || undefined}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                >
                  <IconUpload size={18} />
                  <span className="dropzone__title">
                    {uploadBusy ? 'Reading file…' : 'Drop CSV, TXT or XLSX'}
                  </span>
                  <span className="dropzone__hint">or click to browse</span>
                </label>
                <input
                  id={fileInputId}
                  type="file"
                  accept=".csv,.txt,.tsv,.xlsx,.xls"
                  className="sr-only"
                  onChange={handleFileInput}
                />
              </div>
              {uploaded ? (
                <div className="file-chip">
                  <IconFile size={14} />
                  <span className="file-chip__name" title={uploaded.name}>
                    {uploaded.name}
                  </span>
                  <span className="file-chip__meta">
                    {formatFileSize(uploaded.size)} · {fmtNumber(uploaded.rows, 0)} rows
                  </span>
                </div>
              ) : null}
              {uploadError ? <Notice tone="err">{uploadError}</Notice> : null}
              <p className="tool-hint">
                Accepted columns: distance + elevation, or latitude + longitude + elevation.
                Header names are detected automatically.
              </p>
            </div>
          ) : null}
        </Panel>

        <Panel title="Sampling" tight>
          <div className="field-row">
            <Field
              label="Stations"
              htmlFor={samplesInputId}
              unit="count"
              hint={`${SAMPLE_MIN}–${SAMPLE_MAX} samples`}
            >
              <input
                id={samplesInputId}
                className="input"
                type="number"
                inputMode="numeric"
                min={SAMPLE_MIN}
                max={SAMPLE_MAX}
                step={1}
                value={sampleInput}
                onChange={(event) => applySampleCount(event.target.value)}
                onBlur={() => setSampleInput(String(sampleCount))}
              />
            </Field>
            <div className="field">
              <span className="field__label">
                <span>Smoothing</span>
                <span className="field__unit">moving average</span>
              </span>
              <Segmented
                options={smoothingOptions}
                value={smoothing}
                onChange={setSmoothing}
                label="Elevation smoothing"
                className="segmented--full"
              />
            </div>
          </div>
          <p className="tool-hint">
            Elevations are fetched in batches of {fmtNumber(100, 0)} from Open-Meteo and cached for
            this session. A failed lookup never discards your input.
          </p>
        </Panel>
      </div>

      {/* -------------------------------------------------------------- main */}
      <div className="tool__main">
        <Panel
          title="Map"
          meta={inputMode === 'upload' ? 'Uploaded trace' : 'OSM · WGS 84'}
          tight
          actions={
            <Toolbar label="Map actions">
              <button type="button" className="btn btn--sm btn--quiet" onClick={clearMap} disabled={!hasInput}>
                <IconTrash size={14} /> Clear
              </button>
            </Toolbar>
          }
        >
          <MapCanvas
            mode={inputMode === 'points' ? 'pick-two' : inputMode === 'route' ? 'draw' : 'view'}
            center={DEFAULT_CENTER}
            zoom={DEFAULT_ZOOM}
            markers={markers}
            line={mapLine}
            freehand={inputMode === 'route' && freehand}
            onMapClick={handleMapClick}
            onStrokeDrawn={handleStrokeDrawn}
            onMapError={handleMapError}
            onReady={handleMapReady}
            ariaLabel="Terrain profile map: set endpoints or draw a route"
          >
            <div className="map-overlay map-overlay--tl">
              <div className="map-hud">
                {inputMode === 'points' ? (
                  start && end ? (
                    <>
                      <span>A → B</span>
                      <strong>{fmtLength(geodesicInverse(start, end).distance, 'km')}</strong>
                    </>
                  ) : start ? (
                    <>
                      <span>Point A set</span>
                      <strong>Click to set B</strong>
                    </>
                  ) : (
                    <>
                      <span>No endpoints</span>
                      <strong>Click to set A</strong>
                    </>
                  )
                ) : inputMode === 'route' ? (
                  <>
                    <span>Route vertices</span>
                    <strong>{fmtNumber(route.length, 0)}</strong>
                  </>
                ) : (
                  <>
                    <span>Uploaded trace</span>
                    <strong>{uploaded ? fmtNumber(uploaded.rows, 0) + ' rows' : 'No trace'}</strong>
                  </>
                )}
              </div>
            </div>
            <div className="map-overlay map-overlay--bl">
              <p className="map-hint">
                {inputMode === 'points' ? (
                  <>
                    <strong>Click A, then B.</strong> The profile samples the WGS 84 geodesic between
                    them. Keyboard alternative: type coordinates in the panel.
                  </>
                ) : inputMode === 'route' ? (
                  <>
                    <strong>Click to add vertices.</strong>{' '}
                    {freehand ? 'Or drag to trace a freehand line.' : 'Enable freehand to drag-trace.'}
                  </>
                ) : (
                  <>
                    <strong>Trace from file.</strong> The map is a preview; switch to Two points to
                    sample elevations online.
                  </>
                )}
              </p>
            </div>
          </MapCanvas>
          {mapError ? (
            <Notice tone="warn" title="Basemap unavailable">
              {mapError} Coordinate entry, route paste and uploaded data still work; the profile maths
              is unaffected.
            </Notice>
          ) : null}
        </Panel>

        <Panel
          title="Profile metrics"
          meta={profile ? sourceLabel : 'Awaiting input'}
          actions={
            <Toolbar label="Export profile">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('csv')}
                disabled={!profile || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'csv' ? 'CSV…' : 'CSV'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('json')}
                disabled={!profile || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'json' ? 'JSON…' : 'JSON'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('pdf')}
                disabled={!profile || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'pdf' ? 'PDF…' : 'PDF'}
              </button>
            </Toolbar>
          }
          footer={
            <span className="panel__meta">
              Category thresholds · flat &lt; {fmtNumber(TERRAIN_THRESHOLDS.flat, 0)}% · gentle &lt;{' '}
              {fmtNumber(TERRAIN_THRESHOLDS.gentle, 0)}% · rolling &lt;{' '}
              {fmtNumber(TERRAIN_THRESHOLDS.rolling, 0)}% · hilly &lt;{' '}
              {fmtNumber(TERRAIN_THRESHOLDS.hilly, 0)}%
            </span>
          }
        >
          {profile ? (
            <ReadoutGrid label="Terrain profile metrics">
              <Readout
                label="Distance"
                value={fmtNumber(profile.distance / 1000, 2)}
                unit="km"
                tone="accent"
              />
              <Readout
                label="Elevation gain"
                value={fmtNumber(profile.gain, 1)}
                unit="m"
                delta={`+${fmtNumber(profile.gain, 1)} m climbed`}
              />
              <Readout label="Descent" value={fmtNumber(profile.descent, 1)} unit="m" />
              <Readout label="Net change" value={fmtSigned(profile.net, 1)} unit="m" />
              <Readout label="Minimum" value={fmtNumber(profile.min, 1)} unit="m" />
              <Readout label="Maximum" value={fmtNumber(profile.max, 1)} unit="m" />
              <Readout label="Range" value={fmtNumber(profile.range, 1)} unit="m" />
              <Readout label="Mean elevation" value={fmtNumber(profile.meanElevation, 1)} unit="m" />
              <Readout
                label="Average grade"
                value={fmtNumber(profile.avgSlopePct, 1)}
                unit="%"
              />
              <Readout
                label="Maximum grade"
                value={fmtNumber(profile.maxSlopePct, 1)}
                unit="%"
                delta={`${fmtNumber(profile.maxSlopeDeg, 1)}° at ${fmtNumber(profile.maxSlopeAt / 1000, 2)} km`}
              />
              <Readout
                label="Terrain category"
                value={<Badge tone={categoryTone(profile.category)}>{profile.category}</Badge>}
              />
              <Readout label="Stations" value={fmtNumber(profile.samples.length, 0)} unit="samples" />
            </ReadoutGrid>
          ) : (
            <EmptyState
              icon={<IconTerrain size={22} />}
              title="No profile computed yet"
              action={
                inputMode === 'upload' ? null : (
                  <button type="button" className="btn btn--sm btn--primary" onClick={() => switchInputMode('upload')}>
                    <IconUpload size={14} /> Upload data instead
                  </button>
                )
              }
            >
              Set two points on the map, draw a route, or upload a table with distance and elevation
              columns. Metrics appear here as soon as the profile is sampled.
            </EmptyState>
          )}
          {warnings.length > 0 ? (
            <div className="stack stack--sm">
              {warnings.map((warning, index) => (
                <Notice key={`warning-${index}`} tone="info">
                  {warning}
                </Notice>
              ))}
            </div>
          ) : null}
          {exportError ? <Notice tone="err">{exportError}</Notice> : null}
          {fetchError ? (
            <Notice
              tone="err"
              title="Elevation lookup failed"
              action={
                <div className="btn-row">
                  <button type="button" className="btn btn--sm" onClick={() => setRetryToken((value) => value + 1)}>
                    <IconRefresh size={14} /> Retry
                  </button>
                  <button type="button" className="btn btn--sm" onClick={() => switchInputMode('upload')}>
                    <IconUpload size={14} /> Upload data
                  </button>
                </div>
              }
            >
              {fetchError} The map line is kept, but no profile was computed. Upload a CSV/TXT/XLSX
              with distance and elevation columns to work offline.
            </Notice>
          ) : null}
        </Panel>

        {phase === 'fetching' ? (
          <div className="chart-shell chart-loading">
            <div className="chart-shell__head">
              <span className="chart-shell__title">Elevation profile</span>
              <span className="chart__status">
                {fmtNumber(fetchProgress?.completed ?? 0, 0)} /{' '}
                {fmtNumber(fetchProgress?.total ?? 0, 0)} samples
              </span>
            </div>
            <div className="chart-loading__body">
              <p className="chart-loading__text">Sampling elevations from Open-Meteo…</p>
              <div
                className="progress"
                role="progressbar"
                aria-label="Elevation sampling progress"
                aria-valuemin={0}
                aria-valuemax={fetchProgress?.total ?? 0}
                aria-valuenow={fetchProgress?.completed ?? 0}
              >
                <div
                  className="progress__bar"
                  style={{
                    width: `${fetchProgress && fetchProgress.total > 0 ? (fetchProgress.completed / fetchProgress.total) * 100 : 0}%`,
                  }}
                />
              </div>
            </div>
          </div>
        ) : (
          <ProfileChart
            samples={profile?.samples ?? EMPTY_SAMPLES}
            segments={profile?.segments}
            title="Elevation profile"
            ariaLabel={
              profile
                ? `Elevation profile for ${sourceLabel}: ${fmtLength(profile.distance, 'km')}, ${fmtNumber(
                    profile.min,
                    0,
                  )} to ${fmtNumber(profile.max, 0)} metres, terrain category ${profile.category}.`
                : undefined
            }
          />
        )}

        <Panel
          title="Station table"
          meta={
            profile
              ? `${fmtNumber(stationRows.length, 0)} stations${stationRows.length > TABLE_ROW_LIMIT ? ` · showing first ${fmtNumber(TABLE_ROW_LIMIT, 0)}` : ''}`
              : 'No data'
          }
          tight
        >
          {profile ? (
            <>
              <DataTable
                columns={stationColumns}
                rows={tableRows}
                rowKey={(row) => row.key}
                caption="Terrain profile stations: chainage, elevation, delta distance, slope and bearing."
                empty={<EmptyState title="No stations">Run a profile to populate the station table.</EmptyState>}
              />
              {stationRows.length > TABLE_ROW_LIMIT ? (
                <p className="tool-hint">
                  Table preview limited to {fmtNumber(TABLE_ROW_LIMIT, 0)} rows — export CSV or PDF for
                  the full station list.
                </p>
              ) : null}
            </>
          ) : (
            <EmptyState icon={<IconFile size={20} />} title="No station data">
              Stations appear once a line, route or uploaded table has been sampled.
            </EmptyState>
          )}
        </Panel>
      </div>
    </div>
  );
}
