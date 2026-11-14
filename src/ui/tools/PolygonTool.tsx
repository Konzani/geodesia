/**
 * GEODESIA — Polygon Area & Coordinate Conversion instrument.
 *
 * Two input modes (local Cartesian X/Y metres, WGS 84 decimal-or-DMS lat/lon),
 * an editable vertex table with add/remove/reorder/clear, two-way sync with the
 * map (map clicks append vertices; table edits redraw the ring), an auto-closed
 * ring, planar shoelace + geodesic results, closure, centroid, per-segment
 * distances/bearings, the full land-unit breakdown and an optional user-supplied
 * combined scale factor for ground area.
 */
import { useCallback, useId, useMemo, useRef, useState } from 'react';
import type { LatLon, XYPoint } from '../../math/types';
import {
  computePolygonArea,
  fmtNumber,
  formatDD,
  formatDMS,
  parseDMS,
} from '../../math';
import type { AreaResult, AreaSegment } from '../../math/types';
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
import type { MapCanvasApi, MapMarker } from './MapCanvas';
import { PolygonSketch } from './PolygonSketch';
import {
  IconArrowDown,
  IconArrowUp,
  IconDownload,
  IconGrid,
  IconPlus,
  IconPolygon,
  IconTrash,
} from './icons';
import { errorMessage } from './utils';

type PolygonMode = 'xy' | 'latlon';
type ExportKind = 'csv' | 'json' | 'pdf';

interface VertexRow {
  id: string;
  a: string;
  b: string;
}

interface ParsedVertices {
  points: Array<XYPoint | LatLon>;
  invalidRows: number[];
}

interface SegmentRow {
  key: string;
  segment: string;
  from: string;
  to: string;
  plan: string;
  geodesic: string;
  bearing: string;
}

const modeOptions: ReadonlyArray<{ value: PolygonMode; label: string }> = [
  { value: 'latlon', label: 'WGS 84 lat/lon' },
  { value: 'xy', label: 'Local X/Y (m)' },
];

const DEFAULT_CENTER: LatLon = { lat: -1.2864, lon: 36.8172 };
const DEFAULT_ZOOM = 14;
const XY_EXAMPLE: ReadonlyArray<readonly [string, string]> = [
  ['0', '0'],
  ['85', '0'],
  ['85', '62'],
  ['38', '84'],
  ['0', '62'],
];
const LATLON_EXAMPLE: ReadonlyArray<readonly [string, string]> = [
  ['-1.286400', '36.817200'],
  ['-1.286400', '36.818900'],
  ['-1.287600', '36.818900'],
  ['-1.287600', '36.817200'],
];

function parseValue(value: string, mode: PolygonMode): number | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (mode === 'xy') {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }
  return parseDMS(trimmed);
}

function parseRows(rows: ReadonlyArray<VertexRow>, mode: PolygonMode): ParsedVertices {
  const points: Array<XYPoint | LatLon> = [];
  const invalidRows: number[] = [];
  rows.forEach((row, index) => {
    if (mode === 'xy') {
      const x = parseValue(row.a, mode);
      const y = parseValue(row.b, mode);
      if (x === null || y === null) invalidRows.push(index);
      else points.push({ x, y });
      return;
    }
    const lat = parseValue(row.a, mode);
    const lon = parseValue(row.b, mode);
    if (lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      invalidRows.push(index);
      return;
    }
    points.push({ lat, lon });
  });
  return { points, invalidRows };
}

export default function PolygonTool() {
  const [mode, setMode] = useState<PolygonMode>('latlon');
  const [rows, setRows] = useState<VertexRow[]>([]);
  const [pasteText, setPasteText] = useState('');
  const [pasteError, setPasteError] = useState<string | null>(null);
  const [csfText, setCsfText] = useState('');
  const [statusMessage, setStatusMessage] = useState('');
  const [mapError, setMapError] = useState<string | null>(null);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const rowCounter = useRef(0);
  const fitRef = useRef<((points: ReadonlyArray<LatLon>) => void) | null>(null);
  const csfId = useId();
  const pasteId = useId();

  const makeRow = useCallback((a = '', b = ''): VertexRow => {
    rowCounter.current += 1;
    return { id: `vertex-${rowCounter.current}`, a, b };
  }, []);

  const parsed = useMemo(() => parseRows(rows, mode), [rows, mode]);

  const areaResult = useMemo<AreaResult | null>(() => {
    if (rows.length < 3 || parsed.invalidRows.length > 0) return null;
    try {
      if (mode === 'xy') {
        return computePolygonArea({ mode: 'xy', points: parsed.points as XYPoint[] });
      }
      return computePolygonArea({ mode: 'latlon', points: parsed.points as LatLon[] });
    } catch {
      return null;
    }
  }, [rows.length, parsed, mode]);

  const csf = useMemo<number | null>(() => {
    const trimmed = csfText.trim();
    if (!trimmed) return null;
    const value = Number(trimmed.replace(',', '.'));
    return Number.isFinite(value) && value > 0.5 && value < 2 ? value : null;
  }, [csfText]);
  const csfInvalid = csfText.trim().length > 0 && csf === null;

  const baseArea = areaResult
    ? mode === 'latlon'
      ? areaResult.geodesicArea ?? areaResult.planarArea
      : areaResult.planarArea
    : null;
  const groundArea = baseArea !== null && csf !== null ? baseArea * csf ** 2 : null;

  const latlonPoints = useMemo<LatLon[]>(
    () =>
      mode === 'latlon'
        ? parsed.points.filter((point): point is LatLon => 'lat' in point)
        : [],
    [mode, parsed.points],
  );

  const mapPolygon = areaResult && mode === 'latlon' ? latlonPoints : undefined;

  const mapMarkers = useMemo<MapMarker[]>(() => {
    if (mode !== 'latlon') return [];
    return latlonPoints.map((point, index) => ({
      lat: point.lat,
      lon: point.lon,
      kind: 'vertex',
      label: latlonPoints.length <= 30 ? fmtNumber(index + 1, 0) : undefined,
    }));
  }, [mode, latlonPoints]);

  const fitMap = useCallback(() => {
    if (mode === 'latlon' && latlonPoints.length > 0) fitRef.current?.(latlonPoints);
  }, [mode, latlonPoints]);

  const handleMapClick = useCallback(
    (point: LatLon) => {
      if (mode !== 'latlon') return;
      setRows((previous) => [...previous, makeRow(fmtNumber(point.lat, 6), fmtNumber(point.lon, 6))]);
      setPasteError(null);
      setStatusMessage(`Vertex ${fmtNumber(rows.length + 1, 0)} added from the map.`);
    },
    [makeRow, mode, rows.length],
  );

  const handleMapReady = useCallback((api: MapCanvasApi) => {
    fitRef.current = api.fit;
  }, []);

  /* ---------------------------------------------------------- row editing */
  const updateRow = (id: string, field: 'a' | 'b', value: string) => {
    setRows((previous) => previous.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const addRow = () => {
    setRows((previous) => [...previous, makeRow('', '')]);
    setStatusMessage('Vertex row added. Fill in its coordinates.');
  };

  const removeRow = (id: string) => {
    setRows((previous) => previous.filter((row) => row.id !== id));
    setStatusMessage('Vertex removed. The ring re-closes automatically.');
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
    setPasteError(null);
    setExportError(null);
    setStatusMessage('Vertices cleared.');
  };

  const loadExample = () => {
    const example = mode === 'xy' ? XY_EXAMPLE : LATLON_EXAMPLE;
    setRows(example.map(([a, b]) => makeRow(a, b)));
    setPasteError(null);
    setStatusMessage(`Example parcel loaded with ${fmtNumber(example.length, 0)} vertices.`);
    if (mode === 'latlon') {
      window.setTimeout(() => {
        fitRef.current?.(example.map(([lat, lon]) => ({ lat: Number(lat), lon: Number(lon) })));
      }, 0);
    }
  };

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
      const a = parseValue(parts[0], mode);
      const b = parseValue(parts[1], mode);
      const valid =
        mode === 'xy'
          ? a !== null && b !== null
          : a !== null && b !== null && Math.abs(a) <= 90 && Math.abs(b) <= 180;
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
    if (mode === 'latlon') {
      window.setTimeout(() => {
        fitRef.current?.(next.map((row) => ({ lat: parseDMS(row.a) ?? 0, lon: parseDMS(row.b) ?? 0 })));
      }, 0);
    }
  };

  const switchMode = (next: PolygonMode) => {
    if (next === mode) return;
    setMode(next);
    setPasteError(null);
    setExportError(null);
    if (rows.length > 0) {
      setRows([]);
      setStatusMessage(
        'Coordinate mode changed — vertices cleared so metres and degrees are never mixed.',
      );
    } else {
      setStatusMessage('');
    }
  };

  /* --------------------------------------------------------------- export */
  const segmentRows = useMemo<SegmentRow[]>(() => {
    if (!areaResult) return [];
    return areaResult.segments.map((segment: AreaSegment, index) => ({
      key: `segment-${index}`,
      segment: String(index + 1).padStart(2, '0'),
      from: segment.from,
      to: segment.to,
      plan: fmtNumber(segment.planDistance, 2),
      geodesic: segment.geodesicDistance === null ? '—' : fmtNumber(segment.geodesicDistance, 2),
      bearing: segment.bearing === null ? '—' : fmtNumber(segment.bearing, 1),
    }));
  }, [areaResult]);

  const segmentColumns = useMemo<ReadonlyArray<DataTableColumn<SegmentRow>>>(
    () => [
      { key: 'segment', label: 'Leg', align: 'left' },
      { key: 'from', label: 'From', align: 'left' },
      { key: 'to', label: 'To', align: 'left' },
      { key: 'plan', label: 'Plan dist.', unit: 'm' },
      { key: 'geodesic', label: 'Geodesic', unit: 'm' },
      { key: 'bearing', label: 'Bearing', unit: '°' },
    ],
    [],
  );

  const vertexRecords = useMemo(() => {
    if (!areaResult) return [];
    return rows.map((row, index) => {
      const segment = areaResult.segments[index];
      return {
        index: String(index + 1).padStart(2, '0'),
        a: row.a,
        b: row.b,
        plan: segment ? fmtNumber(segment.planDistance, 2) : '—',
        geodesic:
          segment && segment.geodesicDistance !== null ? fmtNumber(segment.geodesicDistance, 2) : '—',
        bearing: segment && segment.bearing !== null ? fmtNumber(segment.bearing, 1) : '—',
      };
    });
  }, [areaResult, rows]);

  const runExport = async (kind: ExportKind) => {
    if (!areaResult) return;
    setExporting(kind);
    setExportError(null);
    try {
      const slug = 'polygon-area';
      const unitList = areaResult.units;
      const parameters = [
        { label: 'Mode', value: mode === 'latlon' ? 'WGS 84 lat/lon' : 'Local Cartesian X/Y' },
        { label: 'Vertices', value: areaResult.vertexCount },
        { label: 'Ring', value: 'Auto-closed (last → first)' },
        { label: 'CSF', value: csf === null ? 'Not supplied' : fmtNumber(csf, 6) },
      ];
      const metrics = [
        { label: 'Planar area', value: `${fmtNumber(areaResult.planarArea, 2)} m²` },
        { label: 'Planar perimeter', value: `${fmtNumber(areaResult.planarPerimeter, 2)} m` },
        {
          label: 'Geodesic area',
          value: areaResult.geodesicArea === null ? 'n/a' : `${fmtNumber(areaResult.geodesicArea, 2)} m²`,
        },
        {
          label: 'Geodesic perimeter',
          value:
            areaResult.geodesicPerimeter === null
              ? 'n/a'
              : `${fmtNumber(areaResult.geodesicPerimeter, 2)} m`,
        },
        { label: 'Closure leg', value: `${fmtNumber(areaResult.closure, 3)} m` },
        { label: 'Hectares', value: `${fmtNumber(unitList.ha, 4)} ha` },
        { label: 'Acres', value: `${fmtNumber(unitList.acres, 4)} ac` },
        { label: 'Roods', value: `${fmtNumber(unitList.roods, 4)} roods` },
        { label: 'Guntas', value: `${fmtNumber(unitList.guntas, 2)} guntas` },
        { label: 'Ground area (CSF²)', value: groundArea === null ? 'n/a' : `${fmtNumber(groundArea, 2)} m²` },
      ];
      const notes = [
        ...areaResult.warnings,
        csf === null
          ? 'No combined scale factor supplied; areas are ellipsoidal/planar as labelled.'
          : `Ground area uses the user-supplied combined scale factor ${fmtNumber(csf, 6)} (ground = base × CSF²). This factor is not derived from a projection.`,
      ];

      if (kind === 'csv') {
        exportCSV(
          exportFilename(slug, 'csv'),
          [
            { key: 'vertex', label: 'Vertex' },
            { key: 'a', label: mode === 'xy' ? 'X' : 'Latitude', unit: mode === 'xy' ? 'm' : 'deg' },
            { key: 'b', label: mode === 'xy' ? 'Y' : 'Longitude', unit: mode === 'xy' ? 'm' : 'deg' },
            { key: 'plan', label: 'Leg plan distance', unit: 'm' },
            { key: 'geodesic', label: 'Leg geodesic distance', unit: 'm' },
            { key: 'bearing', label: 'Leg bearing', unit: 'deg' },
          ],
          vertexRecords,
          [
            'Geodesia — Polygon Area',
            `Mode: ${mode === 'latlon' ? 'WGS 84 lat/lon' : 'Local Cartesian X/Y'}`,
            `Vertices: ${fmtNumber(areaResult.vertexCount, 0)} (ring auto-closed)`,
            `Planar area: ${fmtNumber(areaResult.planarArea, 2)} m2`,
            `Geodesic area: ${areaResult.geodesicArea === null ? 'n/a' : `${fmtNumber(areaResult.geodesicArea, 2)} m2`}`,
            `Generated: ${timestamp()}`,
          ],
        );
      } else if (kind === 'json') {
        exportJSON(
          exportFilename(slug, 'json'),
          buildVerification(
            {
              tool: 'Polygon Area',
              title: 'Parcel area and closure report',
              method:
                mode === 'latlon'
                  ? 'WGS 84 geodesic polygon (Karney) plus planar Gaussian shoelace on projected coordinates'
                  : 'Planar Gaussian shoelace on local Cartesian coordinates',
              parameters: Object.fromEntries(parameters.map((entry) => [entry.label, entry.value])),
              notes,
            },
            {
              mode,
              planarAreaM2: areaResult.planarArea,
              planarPerimeterM: areaResult.planarPerimeter,
              geodesicAreaM2: areaResult.geodesicArea,
              geodesicPerimeterM: areaResult.geodesicPerimeter,
              closureM: areaResult.closure,
              vertexCount: areaResult.vertexCount,
              centroid:
                mode === 'latlon'
                  ? {
                      lat: (areaResult.centroid as LatLon).lat,
                      lon: (areaResult.centroid as LatLon).lon,
                    }
                  : { x: (areaResult.centroid as XYPoint).x, y: (areaResult.centroid as XYPoint).y },
              centroidFormatted:
                mode === 'latlon'
                  ? `${formatDMS((areaResult.centroid as LatLon).lat, 4, 'lat')}, ${formatDMS((areaResult.centroid as LatLon).lon, 4, 'lon')}`
                  : `X ${fmtNumber((areaResult.centroid as XYPoint).x, 2)} m, Y ${fmtNumber((areaResult.centroid as XYPoint).y, 2)} m`,
              units: unitList,
              groundAreaM2: groundArea,
              combinedScaleFactor: csf,
              ring: 'auto-closed (last → first)',
              vertices: parsed.points.map((point, index) =>
                'x' in point
                  ? { index: index + 1, x: point.x, y: point.y }
                  : { index: index + 1, lat: point.lat, lon: point.lon },
              ),
              segments: areaResult.segments,
              formatted: metrics,
              warnings: areaResult.warnings,
            },
          ),
        );
      } else {
        const spec: PdfReportSpec = {
          meta: {
            tool: 'Polygon Area',
            title: 'Parcel area and closure report',
            subtitle: `${fmtNumber(areaResult.vertexCount, 0)} vertices · ${mode === 'latlon' ? 'WGS 84' : 'Local Cartesian'}`,
            parameters,
            notes,
          },
          sections: [
            { kind: 'kv', heading: 'Area and closure', rows: metrics },
            {
              kind: 'table',
              heading: 'Vertices and legs',
              columns: [
                { label: 'Vertex', align: 'left' },
                { label: mode === 'xy' ? 'X' : 'Latitude', unit: mode === 'xy' ? 'm' : 'deg', align: 'right' },
                { label: mode === 'xy' ? 'Y' : 'Longitude', unit: mode === 'xy' ? 'm' : 'deg', align: 'right' },
                { label: 'Plan', unit: 'm', align: 'right' },
                { label: 'Geodesic', unit: 'm', align: 'right' },
                { label: 'Bearing', unit: 'deg', align: 'right' },
              ],
              rows: vertexRecords.map((record) => [
                record.index,
                record.a,
                record.b,
                record.plan,
                record.geodesic,
                record.bearing,
              ]),
              footnote: 'Ring is auto-closed from the last vertex to the first.',
            },
            {
              kind: 'notes',
              heading: 'Method',
              lines: [
                'Planar area uses the Gaussian trapezoid (shoelace) formula on the supplied coordinates.',
                'Geodesic area and perimeter use the WGS 84 ellipsoid (Karney) when coordinates are geographic.',
                'Closure is the auto-closing leg between the last and first vertex.',
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
  const incompleteCount = parsed.invalidRows.length;
  const resultReady = areaResult !== null;

  const centroidParts = (): Array<{ label: string; value: string; delta: string }> => {
    if (!areaResult) return [];
    if (mode === 'latlon') {
      const centroid = areaResult.centroid as LatLon;
      return [
        {
          label: 'Centroid latitude',
          value: formatDD(centroid.lat, 6, 'lat'),
          delta: formatDMS(centroid.lat, 3, 'lat'),
        },
        {
          label: 'Centroid longitude',
          value: formatDD(centroid.lon, 6, 'lon'),
          delta: formatDMS(centroid.lon, 3, 'lon'),
        },
      ];
    }
    const centroid = areaResult.centroid as XYPoint;
    return [
      { label: 'Centroid X', value: fmtNumber(centroid.x, 2), delta: 'metres from origin' },
      { label: 'Centroid Y', value: fmtNumber(centroid.y, 2), delta: 'metres from origin' },
    ];
  };

  const centroidReadouts = centroidParts();

  return (
    <div className="tool">
      <p className="sr-only" aria-live="polite">
        {statusMessage}
      </p>

      {/* ------------------------------------------------------------- aside */}
      <div className="tool__aside">
        <Panel title="Coordinate mode" tight>
          <Segmented options={modeOptions} value={mode} onChange={switchMode} label="Polygon coordinate mode" />
          <p className="tool-hint">
            {mode === 'latlon'
              ? 'WGS 84 degrees. Accepts decimal or DMS such as 1°23′45.6″S. Geodesic area and perimeter are computed on the ellipsoid.'
              : 'Local Cartesian metres (arbitrary origin). Planar shoelace area and perimeter only — no geodesic result.'}
          </p>
        </Panel>

        <Panel title="Paste vertices" tight>
          <Field
            label="One vertex per line"
            htmlFor={pasteId}
            hint={mode === 'xy' ? '“X, Y” in metres' : '“lat, lon” — decimal or DMS'}
          >
            <textarea
              id={pasteId}
              className="textarea"
              rows={5}
              value={pasteText}
              placeholder={mode === 'xy' ? '0, 0\n85, 0\n85, 62\n0, 62' : '-1.2864, 36.8172\n-1.2864, 36.8189\n-1.2876, 36.8189\n-1.2876, 36.8172'}
              onChange={(event) => setPasteText(event.target.value)}
            />
          </Field>
          {pasteError ? <Notice tone="err">{pasteError}</Notice> : null}
          <div className="btn-row">
            <button type="button" className="btn btn--sm" onClick={applyPaste} disabled={!pasteText.trim()}>
              <IconGrid size={14} /> Load vertices
            </button>
            <button type="button" className="btn btn--sm btn--quiet" onClick={loadExample}>
              Load example
            </button>
          </div>
        </Panel>

        <Panel title="Combined scale factor" tight>
          <Field
            label="CSF"
            htmlFor={csfId}
            unit="optional"
            hint="User-supplied. Ground area = base area × CSF²."
          >
            <input
              id={csfId}
              className="input"
              type="text"
              inputMode="decimal"
              value={csfText}
              placeholder="0.999600"
              aria-invalid={csfInvalid || undefined}
              aria-describedby={csfInvalid ? `${csfId}-error` : undefined}
              onChange={(event) => setCsfText(event.target.value)}
            />
          </Field>
          {csfInvalid ? (
            <Notice tone="err">Enter a factor between 0.5 and 2, for example 0.9996.</Notice>
          ) : null}
          {csf !== null ? (
            <Notice tone="info" title="User-supplied factor">
              Ground area is multiplied by CSF² = {fmtNumber(csf ** 2, 6)}. Verify this factor against
              your project control; it is not derived from a projection.
            </Notice>
          ) : null}
        </Panel>
      </div>

      {/* -------------------------------------------------------------- main */}
      <div className="tool__main">
        <Panel
          title={mode === 'latlon' ? 'Parcel map' : 'Parcel sketch'}
          meta={
            mode === 'latlon'
              ? `${fmtNumber(latlonPoints.length, 0)} vertices · click map to add`
              : 'Local Cartesian preview'
          }
          tight
          actions={
            mode === 'latlon' ? (
              <Toolbar label="Map actions">
                <button
                  type="button"
                  className="btn btn--sm btn--quiet"
                  onClick={fitMap}
                  disabled={latlonPoints.length === 0}
                >
                  Fit
                </button>
              </Toolbar>
            ) : null
          }
        >
          {mode === 'latlon' ? (
            <MapCanvas
              mode="polygon"
              center={DEFAULT_CENTER}
              zoom={DEFAULT_ZOOM}
              markers={mapMarkers}
              polygon={mapPolygon}
              line={latlonPoints.length >= 2 ? latlonPoints : undefined}
              onMapClick={handleMapClick}
              onMapError={setMapError}
              onReady={handleMapReady}
              ariaLabel="Parcel map: click to add vertices in order"
            >
              <div className="map-overlay map-overlay--bl">
                <p className="map-hint">
                  <strong>Click the map to add vertices</strong> in ring order. The ring closes
                  automatically from the last vertex back to the first.
                </p>
              </div>
            </MapCanvas>
          ) : (
            <div className="poly-sketch-shell">
              <PolygonSketch
                points={parsed.points.filter((point): point is XYPoint => 'x' in point)}
                centroid={areaResult && mode === 'xy' ? (areaResult.centroid as XYPoint) : null}
              />
            </div>
          )}
          {mapError ? (
            <Notice tone="warn" title="Basemap unavailable">
              {mapError} The vertex table still works — type or paste coordinates to continue.
            </Notice>
          ) : null}
        </Panel>

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
                  <button type="button" className="btn btn--sm" onClick={loadExample}>
                    Load example parcel
                  </button>
                </div>
              }
            >
              {mode === 'latlon'
                ? 'Click the map to add vertices, paste a coordinate list, or add rows manually.'
                : 'Add rows manually or paste a comma-separated X, Y list.'}
            </EmptyState>
          ) : (
            <>
              {incompleteCount > 0 ? (
                <Notice tone="warn">
                  {fmtNumber(incompleteCount, 0)} row{incompleteCount === 1 ? '' : 's'} cannot be read
                  yet. Complete or remove {incompleteCount === 1 ? 'it' : 'them'} to compute results.
                </Notice>
              ) : null}
              {areaResult && rows.length > areaResult.vertexCount ? (
                <Notice tone="info">
                  The ring is auto-closed, so the repeated first vertex was ignored —{' '}
                  {fmtNumber(areaResult.vertexCount, 0)} distinct vertices are used, with the closing
                  leg computed automatically.
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
                      <th scope="col">{mode === 'xy' ? 'X (m)' : 'Latitude'}</th>
                      <th scope="col">{mode === 'xy' ? 'Y (m)' : 'Longitude'}</th>
                      <th scope="col" className="is-left">
                        <span className="sr-only">Row actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, index) => {
                      const invalid = parsed.invalidRows.includes(index);
                      const aValue = parseValue(row.a, mode);
                      const bValue = parseValue(row.b, mode);
                      return (
                        <tr key={row.id}>
                          <td className="is-left vertex-table__index">{fmtNumber(index + 1, 0)}</td>
                          <td>
                            <input
                              className="input input--cell"
                              value={row.a}
                              inputMode="decimal"
                              aria-label={`Vertex ${index + 1} ${mode === 'xy' ? 'X' : 'latitude'}`}
                              aria-invalid={invalid || undefined}
                              placeholder={mode === 'xy' ? '0.000' : '-1.286400'}
                              onChange={(event) => updateRow(row.id, 'a', event.target.value)}
                            />
                            {mode === 'latlon' && aValue !== null && Math.abs(aValue) <= 90 ? (
                              <span className="vertex-table__dms">{formatDMS(aValue, 2, 'lat')}</span>
                            ) : null}
                          </td>
                          <td>
                            <input
                              className="input input--cell"
                              value={row.b}
                              inputMode="decimal"
                              aria-label={`Vertex ${index + 1} ${mode === 'xy' ? 'Y' : 'longitude'}`}
                              aria-invalid={invalid || undefined}
                              placeholder={mode === 'xy' ? '0.000' : '36.817200'}
                              onChange={(event) => updateRow(row.id, 'b', event.target.value)}
                            />
                            {mode === 'latlon' && bValue !== null && Math.abs(bValue) <= 180 ? (
                              <span className="vertex-table__dms">{formatDMS(bValue, 2, 'lon')}</span>
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
                The ring is closed automatically from the last vertex back to the first — do not
                repeat the first vertex.
              </p>
            </>
          )}
        </Panel>

        <Panel
          title="Area & closure"
          meta={resultReady ? (mode === 'latlon' ? 'WGS 84 · auto-closed' : 'Local Cartesian') : 'Awaiting vertices'}
          actions={
            <Toolbar label="Export polygon report">
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('csv')}
                disabled={!resultReady || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'csv' ? 'CSV…' : 'CSV'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('json')}
                disabled={!resultReady || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'json' ? 'JSON…' : 'JSON'}
              </button>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void runExport('pdf')}
                disabled={!resultReady || exporting !== null}
              >
                <IconDownload size={14} /> {exporting === 'pdf' ? 'PDF…' : 'PDF'}
              </button>
            </Toolbar>
          }
        >
          {areaResult ? (
            <>
              <ReadoutGrid label="Polygon area and closure">
                <Readout
                  label="Planar area (shoelace)"
                  value={fmtNumber(areaResult.planarArea, 2)}
                  unit="m²"
                  tone="accent"
                  wide
                />
                <Readout label="Planar perimeter" value={fmtNumber(areaResult.planarPerimeter, 2)} unit="m" />
                <Readout
                  label="Geodesic area"
                  value={areaResult.geodesicArea === null ? '—' : fmtNumber(areaResult.geodesicArea, 2)}
                  unit={areaResult.geodesicArea === null ? undefined : 'm²'}
                />
                <Readout
                  label="Geodesic perimeter"
                  value={
                    areaResult.geodesicPerimeter === null ? '—' : fmtNumber(areaResult.geodesicPerimeter, 2)
                  }
                  unit={areaResult.geodesicPerimeter === null ? undefined : 'm'}
                />
                <Readout
                  label="Closure leg"
                  value={fmtNumber(areaResult.closure, 3)}
                  unit="m"
                  delta="auto-close last → first"
                />
                <Readout label="Vertices" value={fmtNumber(areaResult.vertexCount, 0)} unit="count" />
                {centroidReadouts.map((entry) => (
                  <Readout
                    key={entry.label}
                    label={entry.label}
                    value={entry.value}
                    delta={entry.delta}
                  />
                ))}
                {groundArea !== null && csf !== null ? (
                  <Readout
                    label="Ground area (CSF²)"
                    value={fmtNumber(groundArea, 2)}
                    unit="m²"
                    delta={`user CSF ${fmtNumber(csf, 6)}`}
                    wide
                  />
                ) : null}
              </ReadoutGrid>
              {areaResult.warnings.length > 0 ? (
                <div className="stack stack--sm">
                  {areaResult.warnings.map((warning, index) => (
                    <Notice key={`polygon-warning-${index}`} tone="warn">
                      {warning}
                    </Notice>
                  ))}
                </div>
              ) : null}
              <p className="tool-hint">
                Planar area is the Gaussian shoelace result on your supplied coordinates.
                {mode === 'latlon'
                  ? ' Geodesic area/perimeter close the ring on the WGS 84 ellipsoid (Karney).'
                  : ' Switch to WGS 84 for ellipsoidal area and geodesic legs.'}
              </p>
            </>
          ) : (
            <EmptyState icon={<IconPolygon size={22} />} title="No closed ring yet">
              Add at least three readable vertices to compute shoelace area, geodesic area, closure
              and the unit breakdown.
            </EmptyState>
          )}
          {exportError ? <Notice tone="err">{exportError}</Notice> : null}
        </Panel>

        {areaResult ? (
          <Panel title="Unit breakdown" meta={`${fmtNumber(areaResult.vertexCount, 0)} vertices`}>
            <ReadoutGrid label="Area in every supported unit">
              <Readout label="Square metres" value={fmtNumber(areaResult.units.m2, 2)} unit="m²" />
              <Readout label="Hectares" value={fmtNumber(areaResult.units.ha, 4)} unit="ha" />
              <Readout label="Acres" value={fmtNumber(areaResult.units.acres, 4)} unit="ac" />
              <Readout label="Square kilometres" value={fmtNumber(areaResult.units.km2, 6)} unit="km²" />
              <Readout label="Square feet" value={fmtNumber(areaResult.units.ft2, 2)} unit="ft²" />
              <Readout label="Roods" value={fmtNumber(areaResult.units.roods, 4)} unit="roods" />
              <Readout label="Guntas" value={fmtNumber(areaResult.units.guntas, 2)} unit="guntas" />
            </ReadoutGrid>
            <p className="tool-hint">
              Roods and guntas are Kenyan cadastral/agricultural convenience units; values are exact
              conversions of the computed area.
            </p>
          </Panel>
        ) : null}

        {areaResult ? (
          <Panel title="Per-segment geometry" meta={`${fmtNumber(segmentRows.length, 0)} legs`} tight>
            <DataTable
              columns={segmentColumns}
              rows={segmentRows}
              rowKey={(row) => row.key}
              caption="Polygon legs: planar distance, geodesic distance and bearing from each vertex to the next."
              empty={<EmptyState title="No legs">Add vertices to compute per-segment geometry.</EmptyState>}
            />
          </Panel>
        ) : null}
      </div>
    </div>
  );
}
