/**
 * GEODESIA â€” resilient Leaflet wrapper.
 *
 * Leaflet touches `window` the moment it is imported, so its JS is loaded with a
 * dynamic `import()` inside an effect and never at module scope. Its CSS, on the
 * other hand, is imported statically: Astro inlines stylesheets at build time, and
 * a *dynamic* CSS import would emit a `__vitePreload` call for a file the build
 * never writes (that exact bug blanked the map on geodesia.online â€” the preload
 * 404'd, the promise rejected and the map fell into its error state). Static CSS
 * imports are compile-time only, so this module stays SSR-safe.
 *
 * Basemaps: three layers (`basemap.ts`) â€” satellite imagery by default, plus
 * terrain and streets â€” each with its own ordered provider chain. The active
 * provider is always named in the status pill, and when a provider keeps failing
 * the next one in that layer's chain is mounted automatically with its own
 * attribution. The map never silently shows an empty grey box, and if Leaflet
 * itself fails to load the user gets a retry button plus coordinate entry.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import 'leaflet/dist/leaflet.css';
import '../styles/map.css';
import type { LatLon } from '../../math/types';
import {
  BASEMAP_LAYERS,
  BASEMAP_LAYER_ORDER,
  DEFAULT_BASEMAP_LAYER,
  DEFAULT_SHOW_LABELS,
  MAP_DEFAULT_VIEW,
  TRANSPARENT_TILE,
  resolveBasemapLayer,
} from './basemap';
import type { BasemapLayerId } from './basemap';
import { evaluateTileHealth, nextProviderIndex, providerCountFor } from './basemap-chain';
import { cx, tokenColor } from './utils';

export type MapMode = 'pick-two' | 'draw' | 'polygon' | 'view';
export type MapPointKind = 'start' | 'end' | 'point' | 'vertex';

export interface MapMarker {
  lat: number;
  lon: number;
  kind?: MapPointKind;
  label?: string;
}

/** Result of the basemap provider chain, surfaced to the parent for status copy. */
export interface BasemapChange {
  id: string;
  label: string;
  status: 'loading' | 'ok' | 'fallback' | 'failed';
  /** Active layer id, so the parent can describe the map in its own copy. */
  layer?: BasemapLayerId;
}

/** Imperative helpers handed to the parent once the map has initialised. */
export interface MapCanvasApi {
  fit: (points: ReadonlyArray<LatLon>, padding?: number) => void;
  setView: (center: LatLon, zoom?: number) => void;
  invalidate: () => void;
}

export interface MapCanvasProps {
  mode: MapMode;
  center?: LatLon;
  zoom?: number;
  markers?: ReadonlyArray<MapMarker>;
  /** Geodesic line or route to draw (2+ points). */
  line?: ReadonlyArray<LatLon>;
  /** Closed vertex ring to draw (3+ points). */
  polygon?: ReadonlyArray<LatLon>;
  /** In 'draw' mode, enable pointer-drag freehand tracing. */
  freehand?: boolean;
  onMapClick?: (point: LatLon) => void;
  /** Freehand stroke finished with 2+ points. */
  onStrokeDrawn?: (points: LatLon[]) => void;
  /** Called when Leaflet or every basemap provider fails. */
  onMapError?: (message: string) => void;
  /** Called whenever the active basemap provider changes. */
  onBasemapChange?: (change: BasemapChange) => void;
  onReady?: (api: MapCanvasApi) => void;
  /** Layer to open with; defaults to the stored preference then Satellite. */
  initialLayer?: BasemapLayerId;
  /** Labels overlay default; defaults to the stored preference then on. */
  initialShowLabels?: boolean;
  /** Overlays (HUDs, hints) rendered above the map inside the shell. */
  children?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

type LeafletModule = typeof import('leaflet');
type LeafletMap = import('leaflet').Map;
type LeafletTileLayer = import('leaflet').TileLayer;

/** Milliseconds to wait for a first tile before falling through to the next provider. */
const PROVIDER_TIMEOUT_MS = 8_000;

const LAYER_STORAGE_KEY = 'geodesia.basemap.layer';
const LABELS_STORAGE_KEY = 'geodesia.basemap.labels';

/* ------------------------------------------------------------------ loader */

let leafletPromise: Promise<LeafletModule> | null = null;

async function importLeafletWithRetry(attempts = 2): Promise<LeafletModule> {
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const module = await import('leaflet');
      return ((module as LeafletModule & { default?: LeafletModule }).default ?? module) as LeafletModule;
    } catch (error) {
      lastError = error;
      // A transient chunk/CDN hiccup is worth one more try; a hard failure is
      // reported to the user with a retry button rather than hidden.
      await new Promise((resolve) => window.setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Leaflet failed to load');
}

/** Load Leaflet once per page; a rejected promise is forgotten so retry works. */
export function loadLeaflet(): Promise<LeafletModule> {
  if (!leafletPromise) {
    leafletPromise = importLeafletWithRetry().catch((error) => {
      leafletPromise = null;
      throw error;
    });
  }
  return leafletPromise;
}

/* ------------------------------------------------------------------ helpers */

function readStoredLayer(fallback: BasemapLayerId): BasemapLayerId {
  try {
    const stored = window.localStorage.getItem(LAYER_STORAGE_KEY);
    return stored ? resolveBasemapLayer(stored) : fallback;
  } catch {
    return fallback;
  }
}

function readStoredLabels(fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(LABELS_STORAGE_KEY);
    if (stored === 'true') return true;
    if (stored === 'false') return false;
    return fallback;
  } catch {
    return fallback;
  }
}

function decimatePath(points: LatLon[], maxPoints: number): LatLon[] {
  if (points.length <= maxPoints) return points;
  const stride = Math.ceil(points.length / maxPoints);
  const out = points.filter((_, index) => index % stride === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

export function MapCanvas({
  mode,
  center,
  zoom,
  markers,
  line,
  polygon,
  freehand = false,
  onMapClick,
  onStrokeDrawn,
  onMapError,
  onBasemapChange,
  onReady,
  initialLayer = DEFAULT_BASEMAP_LAYER,
  initialShowLabels = DEFAULT_SHOW_LABELS,
  children,
  className,
  ariaLabel = 'Survey map',
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<LeafletMap | null>(null);
  const leafletRef = useRef<LeafletModule | null>(null);
  const initialisingRef = useRef(false);
  const markerLayerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const lineLayerRef = useRef<import('leaflet').Polyline | null>(null);
  const polygonLayerRef = useRef<import('leaflet').Polygon | null>(null);
  const locateLayerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const applyLayerRef = useRef<((layer: BasemapLayerId, labels: boolean) => void) | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [themeVersion, setThemeVersion] = useState(0);
  const [layerId, setLayerId] = useState<BasemapLayerId>(initialLayer);
  const [showLabels, setShowLabels] = useState(initialShowLabels);
  const [locating, setLocating] = useState(false);
  const [locateNote, setLocateNote] = useState<string | null>(null);
  const [basemap, setBasemap] = useState<BasemapChange>({
    id: initialLayer,
    label: BASEMAP_LAYERS[initialLayer].providers[0]?.label ?? 'Basemap',
    status: 'loading',
    layer: initialLayer,
  });

  const layer = BASEMAP_LAYERS[layerId];

  // Latest props for long-lived Leaflet event handlers.
  const latest = useRef({
    center: center ?? MAP_DEFAULT_VIEW.center,
    zoom: zoom ?? MAP_DEFAULT_VIEW.zoom,
    onMapClick,
    onStrokeDrawn,
    onMapError,
    onBasemapChange,
    onReady,
  });
  latest.current = {
    center: center ?? latest.current.center,
    zoom: zoom ?? latest.current.zoom,
    onMapClick,
    onStrokeDrawn,
    onMapError,
    onBasemapChange,
    onReady,
  };

  /* --------------------------------------------------- stored preferences */
  // Read after hydration, never during the first render, so server markup and
  // the first client render agree.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    setLayerId(readStoredLayer(initialLayer));
    setShowLabels(readStoredLabels(initialShowLabels));
  }, [initialLayer, initialShowLabels]);

  useEffect(() => {
    try {
      window.localStorage.setItem(LAYER_STORAGE_KEY, layerId);
      window.localStorage.setItem(LABELS_STORAGE_KEY, String(showLabels));
    } catch {
      /* private mode / storage disabled â€” preference is session-only */
    }
  }, [layerId, showLabels]);

  /* ---------------------------------------------------------------- mount */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || initialisingRef.current) return;
    initialisingRef.current = true;
    setMapReady(false);
    setFailure(null);

    let disposed = false;
    let map: LeafletMap | null = null;
    let themeObserver: MutationObserver | null = null;
    let resizeCleanup: (() => void) | null = null;
    let providerCleanup: (() => void) | null = null;
    let labelLayer: LeafletTileLayer | null = null;
    let activeLayerId: BasemapLayerId = layerId;
    let providerIndex = 0;

    const publish = (change: BasemapChange) => {
      if (disposed) return;
      setBasemap(change);
      latest.current.onBasemapChange?.(change);
    };

    const failBasemap = (message: string) => {
      const chain = BASEMAP_LAYERS[activeLayerId].providers;
      const failedProvider = chain[providerIndex];
      setFailure(message);
      publish({
        id: failedProvider?.id ?? 'none',
        label: failedProvider?.label ?? 'Basemap',
        status: 'failed',
        layer: activeLayerId,
      });
      latest.current.onMapError?.(message);
    };

    void (async () => {
      try {
        const L = await loadLeaflet();
        if (disposed) return;
        leafletRef.current = L;

        const start = latest.current;
        map = L.map(container, {
          center: [start.center.lat, start.center.lon],
          zoom: start.zoom,
          minZoom: 2,
          // Imagery is native to 19 and upscaled beyond; Leaflet handles the gap.
          maxZoom: 21,
          zoomSnap: 0.5,
          wheelPxPerZoomLevel: 120,
          worldCopyJump: true,
          keyboard: true,
          attributionControl: true,
          zoomControl: false,
        });
        mapRef.current = map;

        markerLayerRef.current = L.layerGroup().addTo(map);
        locateLayerRef.current = L.layerGroup().addTo(map);
        L.control.zoom({ position: 'bottomright' }).addTo(map);
        L.control.scale({ metric: true, imperial: false, position: 'bottomright' }).addTo(map);

        /* --------------------------------------------------- fit scheduling */
        // Fit requests are deferred to the next animation frame with an
        // invalidateSize first: the map can be mounted inside a 0-height hidden
        // tab, and Leaflet computes bounds against the container size at call
        // time. A pending fit is replayed once the first tile arrives too.
        let pendingFit: { points: ReadonlyArray<LatLon>; padding: number } | null = null;
        let fitFrame = 0;
        let refitAfterTiles = false;

        const performFit = () => {
          if (!map || !pendingFit) return;
          const { points, padding } = pendingFit;
          if (points.length === 0) return;
          if (points.length === 1) {
            map.setView([points[0].lat, points[0].lon], Math.max(map.getZoom(), 14), { animate: false });
            return;
          }
          const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon] as [number, number]));
          map.fitBounds(bounds, { padding: [padding, padding], maxZoom: 18, animate: false });
        };

        const requestFit = (points?: ReadonlyArray<LatLon>, padding = 32) => {
          if (points) pendingFit = { points: [...points], padding };
          if (!map) return;
          cancelAnimationFrame(fitFrame);
          map.invalidateSize();
          fitFrame = requestAnimationFrame(() => {
            map?.invalidateSize();
            performFit();
          });
        };

        /* ------------------------------------------------------ label layer */
        const applyLabels = (show: boolean) => {
          if (!map) return;
          const overlay = BASEMAP_LAYERS[activeLayerId].overlay;
          if (!overlay || !show) {
            labelLayer?.remove();
            labelLayer = null;
            return;
          }
          if (labelLayer) return;
          labelLayer = L.tileLayer(overlay.url, {
            maxZoom: overlay.maxZoom,
            maxNativeZoom: overlay.maxNativeZoom ?? overlay.maxZoom,
            attribution: overlay.attribution,
            subdomains: overlay.subdomains ?? 'abc',
            crossOrigin: true,
            errorTileUrl: TRANSPARENT_TILE,
            opacity: 1,
            updateWhenIdle: false,
            zIndex: 3,
          });
          labelLayer.addTo(map);
        };

        /* ---------------------------------------------------- provider chain */
        const mountProvider = (): void => {
          if (!map || disposed) return;
          providerCleanup?.();
          providerCleanup = null;

          const chain = BASEMAP_LAYERS[activeLayerId].providers;
          const provider = chain[providerIndex];
          if (!provider) {
            failBasemap(
              'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
            );
            return;
          }

          publish({
            id: provider.id,
            label: provider.label,
            status: providerIndex === 0 ? 'loading' : 'fallback',
            layer: activeLayerId,
          });

          const tileLayer = L.tileLayer(provider.url, {
            maxZoom: provider.maxZoom,
            maxNativeZoom: provider.maxNativeZoom ?? provider.maxZoom,
            attribution: provider.attribution,
            subdomains: provider.subdomains ?? 'abc',
            crossOrigin: true,
            errorTileUrl: TRANSPARENT_TILE,
            keepBuffer: 2,
            updateWhenIdle: false,
          });
          tileLayer.addTo(map);

          let loadedTiles = 0;
          let errorsSinceLoad = 0;
          let switched = false;
          let timeout = 0;
          let announced = false;

          const clearTimer = () => {
            if (timeout) window.clearTimeout(timeout);
            timeout = 0;
          };

          const switchTo = (nextIndex: number) => {
            if (switched || disposed) return;
            switched = true;
            clearTimer();
            tileLayer.off();
            tileLayer.remove();
            providerIndex = nextIndex;
            const next = chain[providerIndex];
            if (next) {
              publish({ id: next.id, label: next.label, status: 'fallback', layer: activeLayerId });
              mountProvider();
            } else {
              failBasemap(
                'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
              );
            }
          };

          const advance = () => {
            const count = providerCountFor(activeLayerId);
            if (providerIndex >= count - 1) {
              failBasemap(
                'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
              );
              return;
            }
            switchTo(nextProviderIndex(providerIndex, count));
          };

          timeout = window.setTimeout(() => {
            if (!switched && loadedTiles === 0) advance();
          }, PROVIDER_TIMEOUT_MS);

          tileLayer.on('tileload', () => {
            loadedTiles += 1;
            errorsSinceLoad = 0;
            if (switched) return;
            clearTimer();
            if (!announced) {
              announced = true;
              publish({
                id: provider.id,
                label: provider.label,
                status: providerIndex === 0 ? 'ok' : 'fallback',
                layer: activeLayerId,
              });
            }
            // Replay a fit request once the basemap proves alive so the ring is
            // framed correctly even if the first fit ran against an empty size.
            if (!refitAfterTiles) {
              refitAfterTiles = true;
              if (pendingFit) requestFit();
            }
          });

          tileLayer.on('tileerror', () => {
            if (switched) return;
            errorsSinceLoad += 1;
            const action = evaluateTileHealth(
              { loadedTiles, errorsSinceLoad },
              providerIndex,
              providerCountFor(activeLayerId),
            );
            if (action === 'switch') advance();
            else if (action === 'fail') {
              failBasemap(
                'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
              );
            }
          });

          providerCleanup = () => {
            switched = true;
            clearTimer();
            tileLayer.off();
            tileLayer.remove();
          };
        };

        const switchLayer = (nextLayerId: BasemapLayerId, labels: boolean) => {
          if (!map || disposed) return;
          activeLayerId = nextLayerId;
          providerIndex = 0;
          providerCleanup?.();
          providerCleanup = null;
          labelLayer?.remove();
          labelLayer = null;
          mountProvider();
          applyLabels(labels);
        };
        applyLayerRef.current = switchLayer;

        mountProvider();
        applyLabels(showLabels);

        // Keep the map sized when it starts hidden in a tab panel or reflows.
        let resizeFrame = 0;
        let resizeObserver: ResizeObserver | null = null;
        const invalidate = () => {
          cancelAnimationFrame(resizeFrame);
          resizeFrame = requestAnimationFrame(() => map?.invalidateSize());
        };
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(invalidate);
          resizeObserver.observe(container);
        }
        resizeCleanup = () => {
          resizeObserver?.disconnect();
          cancelAnimationFrame(resizeFrame);
        };

        map.whenReady(() => {
          if (disposed || !map) return;
          map.invalidateSize();
          setMapReady(true);
          latest.current.onReady?.({
            fit: (points, padding = 32) => requestFit(points, padding),
            setView: (nextCenter, nextZoom) => {
              map?.setView([nextCenter.lat, nextCenter.lon], nextZoom ?? map.getZoom(), { animate: false });
            },
            invalidate: () => map?.invalidateSize(),
          });
        });

        themeObserver = new MutationObserver(() => setThemeVersion((version) => version + 1));
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
      } catch {
        if (!disposed) {
          failBasemap(
            'The map library could not be loaded. Use Retry, or enter coordinates â€” tables, exports and uploaded data still work.',
          );
        }
      }
    })();

    return () => {
      disposed = true;
      initialisingRef.current = false;
      applyLayerRef.current = null;
      themeObserver?.disconnect();
      resizeCleanup?.();
      providerCleanup?.();
      providerCleanup = null;
      labelLayer?.remove();
      labelLayer = null;
      lineLayerRef.current?.remove();
      polygonLayerRef.current?.remove();
      markerLayerRef.current = null;
      lineLayerRef.current = null;
      polygonLayerRef.current = null;
      locateLayerRef.current = null;
      map?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
    // `attempt` is the retry counter: bumping it tears the map down and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt]);

  /* ------------------------------------------- layer / labels application */
  useEffect(() => {
    if (!mapReady) return;
    applyLayerRef.current?.(layerId, showLabels);
  }, [mapReady, layerId, showLabels]);

  /* --------------------------------------------------------- interactions */
  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;

    const isFreehand = mode === 'draw' && freehand;
    if (isFreehand) map.dragging.disable();
    else map.dragging.enable();

    let strokeActive = false;
    let suppressNextClick = false;
    let strokeMoved = false;
    let stroke: import('leaflet').Polyline | null = null;
    let strokePoints: LatLon[] = [];
    let lastContainerPoint: import('leaflet').Point | null = null;

    const onClick = (event: import('leaflet').LeafletMouseEvent) => {
      if (mode === 'view') return;
      if (suppressNextClick) {
        suppressNextClick = false;
        return;
      }
      latest.current.onMapClick?.({ lat: event.latlng.lat, lon: event.latlng.lng });
    };
    map.on('click', onClick);

    const finishStroke = () => {
      if (!strokeActive) return;
      strokeActive = false;
      stroke?.remove();
      stroke = null;
      const drawn = strokePoints;
      strokePoints = [];
      lastContainerPoint = null;
      if (strokeMoved) suppressNextClick = true;
      strokeMoved = false;
      if (drawn.length >= 2) latest.current.onStrokeDrawn?.(decimatePath(drawn, 600));
    };

    const onDown = (event: import('leaflet').LeafletMouseEvent) => {
      if (!isFreehand || event.originalEvent.button !== 0) return;
      strokeActive = true;
      strokeMoved = false;
      strokePoints = [{ lat: event.latlng.lat, lon: event.latlng.lng }];
      lastContainerPoint = event.containerPoint;
      stroke = L.polyline([[event.latlng.lat, event.latlng.lng]], {
        color: tokenColor('--accent'),
        weight: 2,
        opacity: 0.95,
        interactive: false,
      }).addTo(map);
    };

    const onMove = (event: import('leaflet').LeafletMouseEvent) => {
      if (!strokeActive) return;
      const point = event.containerPoint;
      if (lastContainerPoint && point.distanceTo(lastContainerPoint) < 3) return;
      strokeMoved = true;
      lastContainerPoint = point;
      strokePoints.push({ lat: event.latlng.lat, lon: event.latlng.lng });
      stroke?.setLatLngs(strokePoints.map((sample) => [sample.lat, sample.lon] as [number, number]));
    };

    const onDocumentMouseUp = () => finishStroke();

    if (isFreehand) {
      map.on('mousedown', onDown);
      map.on('mousemove', onMove);
      map.on('mouseup', finishStroke);
      document.addEventListener('mouseup', onDocumentMouseUp);
    }

    return () => {
      map.off('click', onClick);
      if (isFreehand) {
        map.off('mousedown', onDown);
        map.off('mousemove', onMove);
        map.off('mouseup', finishStroke);
        document.removeEventListener('mouseup', onDocumentMouseUp);
      }
      finishStroke();
      map.dragging.enable();
    };
  }, [mapReady, mode, freehand]);

  /* ------------------------------------------------------------- rendering */
  const geometrySignature = JSON.stringify([markers ?? [], line ?? [], polygon ?? []]);

  useEffect(() => {
    const map = mapRef.current;
    const L = leafletRef.current;
    const markerLayer = markerLayerRef.current;
    if (!map || !L || !markerLayer || !mapReady) return;

    const accent = tokenColor('--accent');
    const primary = tokenColor('--data-primary');
    const secondary = tokenColor('--data-secondary');
    const paper = tokenColor('--bg-raised', 'white');

    markerLayer.clearLayers();
    for (const marker of markers ?? []) {
      if (!Number.isFinite(marker.lat) || !Number.isFinite(marker.lon)) continue;
      const kind = marker.kind ?? 'point';
      const fill = kind === 'start' ? accent : kind === 'end' ? primary : kind === 'vertex' ? secondary : accent;
      const dot = L.circleMarker([marker.lat, marker.lon], {
        radius: kind === 'vertex' ? 4 : 6,
        color: paper,
        weight: 2,
        opacity: 1,
        fillColor: fill,
        fillOpacity: 1,
      });
      if (marker.label) {
        dot.bindTooltip(marker.label, {
          permanent: true,
          direction: 'top',
          offset: [0, -8],
          className: 'map-point-label',
          opacity: 1,
        });
      }
      dot.addTo(markerLayer);
    }

    lineLayerRef.current?.remove();
    lineLayerRef.current = null;
    if (line && line.length >= 2) {
      lineLayerRef.current = L.polyline(
        line.map((point) => [point.lat, point.lon] as [number, number]),
        { color: accent, weight: 2.5, opacity: 0.95, interactive: false },
      ).addTo(map);
    }

    polygonLayerRef.current?.remove();
    polygonLayerRef.current = null;
    if (polygon && polygon.length >= 3) {
      polygonLayerRef.current = L.polygon(
        polygon.map((point) => [point.lat, point.lon] as [number, number]),
        {
          color: primary,
          weight: 1.5,
          opacity: 0.9,
          fillColor: primary,
          fillOpacity: 0.14,
          interactive: false,
        },
      ).addTo(map);
    }
    // `geometrySignature` is the deliberate trigger: arrays are rebuilt by the
    // parent on every render, the signature only changes when geometry does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapReady, geometrySignature, themeVersion]);

  /* ---------------------------------------------------------- center/zoom */
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady || !center) return;
    const current = map.getCenter();
    const moved =
      Math.abs(current.lat - center.lat) > 1e-7 || Math.abs(current.lng - center.lon) > 1e-7;
    const zoomChanged = zoom !== undefined && Math.abs(map.getZoom() - zoom) > 1e-9;
    if (moved || zoomChanged) {
      map.setView([center.lat, center.lon], zoom ?? map.getZoom(), { animate: false });
    }
  }, [mapReady, center, zoom]);

  const chooseLayer = (next: BasemapLayerId) => {
    setLayerId(next);
  };

  const toggleLabels = () => setShowLabels((value) => !value);

  /** Centre on the user's own device location â€” the fastest way to find a plot. */
  const locateMe = () => {
    const map = mapRef.current;
    const L = leafletRef.current;
    if (!map || !L || !mapReady) return;
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocateNote('This browser cannot share a location â€” zoom the map instead.');
      return;
    }
    setLocating(true);
    setLocateNote(null);
    navigator.geolocation.getCurrentPosition(
      (position) => {
        setLocating(false);
        const point = { lat: position.coords.latitude, lon: position.coords.longitude };
        map.setView([point.lat, point.lon], Math.max(map.getZoom(), 16), { animate: true });
        const layerGroup = locateLayerRef.current;
        if (layerGroup) {
          layerGroup.clearLayers();
          L.circleMarker([point.lat, point.lon], {
            radius: 7,
            color: tokenColor('--bg-raised', 'white'),
            weight: 2,
            fillColor: tokenColor('--accent'),
            fillOpacity: 1,
          }).addTo(layerGroup);
        }
      },
      () => {
        setLocating(false);
        setLocateNote('Location unavailable â€” zoom or search the map instead.');
      },
      { enableHighAccuracy: true, timeout: 9_000, maximumAge: 60_000 },
    );
  };

  const retry = () => {
    setFailure(null);
    setMapReady(false);
    setAttempt((value) => value + 1);
  };

  const basemapText =
    basemap.status === 'loading'
      ? `Basemap: ${basemap.label} â€” loading tilesâ€¦`
      : basemap.status === 'ok'
        ? `Basemap: ${basemap.label}`
        : basemap.status === 'fallback'
          ? `Fallback basemap: ${basemap.label}`
          : `Basemap failed: ${basemap.label} â€” coordinate entry still works`;

  return (
    <div
      className={cx('map-shell', className)}
      data-mode={mode}
      data-basemap-status={basemap.status}
      data-basemap-provider={basemap.id}
      data-basemap-layer={layerId}
      data-labels={showLabels ? 'on' : 'off'}
      data-map-ready={mapReady ? 'true' : undefined}
    >
      <div ref={containerRef} className="map-canvas" role="region" aria-label={ariaLabel} />
      <div className="map-overlay map-overlay--tr">
        <p
          className={`basemap-status basemap-status--${basemap.status}`}
          role="status"
          aria-live="polite"
          title={`Tile source: ${basemap.label} (${basemap.id})`}
        >
          {basemapText}
        </p>
      </div>
      {!mapReady && !failure ? (
        <div className="map-overlay map-overlay--tc">
          <div className="map-hud" aria-live="polite">
            Loading basemapâ€¦
          </div>
        </div>
      ) : null}
      {failure ? (
        <div className="map-fallback">
          <div className="map-fallback__panel" role="status">
            <strong>Map unavailable</strong>
            <p>{failure}</p>
            <button type="button" className="btn btn--sm" onClick={retry}>
              Retry map
            </button>
          </div>
        </div>
      ) : null}
      <div className="map-dock" role="group" aria-label="Basemap options">
        <div className="map-dock__row">
          <div className="basemap-switch" role="group" aria-label="Basemap layer">
            {BASEMAP_LAYER_ORDER.map((id) => {
              const candidate = BASEMAP_LAYERS[id];
              return (
                <button
                  key={id}
                  type="button"
                  className="basemap-switch__btn"
                  aria-pressed={layerId === id}
                  title={candidate.hint}
                  onClick={() => chooseLayer(id)}
                >
                  {candidate.label}
                </button>
              );
            })}
            {layer.overlay ? (
              <button
                type="button"
                className="basemap-switch__btn basemap-switch__btn--labels"
                aria-pressed={showLabels}
                title="Show place names and boundaries over the imagery"
                onClick={toggleLabels}
              >
                Labels
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="map-action"
            onClick={locateMe}
            disabled={!mapReady || locating}
            aria-busy={locating}
            title="Zoom to your device location"
          >
            {locating ? 'Locatingâ€¦' : 'My location'}
          </button>
        </div>
        <p className="basemap-hint">{locateNote ?? layer.hint}</p>
      </div>
      {children}
    </div>
  );
}
