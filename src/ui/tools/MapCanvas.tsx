/**
 * GEODESIA — resilient Leaflet wrapper.
 *
 * Leaflet touches `window` the moment it is imported, so it is loaded with a
 * dynamic `import()` inside an effect (CSS included) and never at module scope.
 * This module is SSR-safe: on the server it renders only the map shell and a
 * loading status, and the parent always offers coordinate entry as an alternative.
 *
 * Basemap strategy: `TILE_PROVIDERS` (Geodesia edge worker first, then Esri topo,
 * CARTO, OSM). If a provider keeps failing, the next one is mounted automatically
 * with its own attribution, and the current source is always stated in a status
 * pill — the map never silently shows an empty grey box. Vector overlays are
 * coloured from design tokens, not hardcoded hex.
 */
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { LatLon } from '../../math/types';
import { MAP_DEFAULT_VIEW, TILE_PROVIDERS, TRANSPARENT_TILE } from './basemap';
import { evaluateTileHealth, nextProviderIndex } from './basemap-chain';
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
  /** Overlays (HUDs, hints) rendered above the map inside the shell. */
  children?: ReactNode;
  className?: string;
  ariaLabel?: string;
}

type LeafletModule = typeof import('leaflet');

/** Tile failures (within a provider) required before switching to the next source. */
/** Milliseconds to wait for a first tile before falling through to the next provider. */
const PROVIDER_TIMEOUT_MS = 9_000;

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
  children,
  className,
  ariaLabel = 'Survey map',
}: MapCanvasProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<import('leaflet').Map | null>(null);
  const leafletRef = useRef<LeafletModule | null>(null);
  const initialisingRef = useRef(false);
  const markerLayerRef = useRef<import('leaflet').LayerGroup | null>(null);
  const lineLayerRef = useRef<import('leaflet').Polyline | null>(null);
  const polygonLayerRef = useRef<import('leaflet').Polygon | null>(null);

  const [mapReady, setMapReady] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [themeVersion, setThemeVersion] = useState(0);
  const [basemap, setBasemap] = useState<BasemapChange>({
    id: TILE_PROVIDERS[0]?.id ?? 'none',
    label: TILE_PROVIDERS[0]?.label ?? 'Basemap',
    status: 'loading',
  });

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

  /* ---------------------------------------------------------------- mount */
  useEffect(() => {
    const container = containerRef.current;
    if (!container || mapRef.current || initialisingRef.current) return;
    initialisingRef.current = true;

    let disposed = false;
    let map: import('leaflet').Map | null = null;
    let themeObserver: MutationObserver | null = null;
    let resizeCleanup: (() => void) | null = null;
    let providerCleanup: (() => void) | null = null;
    let providerIndex = 0;

    const publish = (change: BasemapChange) => {
      if (disposed) return;
      setBasemap(change);
      latest.current.onBasemapChange?.(change);
    };

    const failBasemap = (message: string) => {
      const failedProvider = TILE_PROVIDERS[providerIndex];
      setFailure(message);
      publish({
        id: failedProvider?.id ?? 'none',
        label: failedProvider?.label ?? 'Basemap',
        status: 'failed',
      });
      latest.current.onMapError?.(message);
    };

    void (async () => {
      try {
        await import('leaflet/dist/leaflet.css');
        const module = await import('leaflet');
        if (disposed) return;
        const L = ((module as LeafletModule & { default?: LeafletModule }).default ?? module) as LeafletModule;
        leafletRef.current = L;

        const start = latest.current;
        map = L.map(container, {
          center: [start.center.lat, start.center.lon],
          zoom: start.zoom,
          minZoom: 2,
          maxZoom: 20,
          zoomSnap: 0.5,
          worldCopyJump: true,
          keyboard: true,
          attributionControl: true,
          zoomControl: false,
        });
        mapRef.current = map;

        markerLayerRef.current = L.layerGroup().addTo(map);
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
            map.setView([points[0].lat, points[0].lon], Math.max(map.getZoom(), 13), { animate: false });
            return;
          }
          const bounds = L.latLngBounds(points.map((point) => [point.lat, point.lon] as [number, number]));
          map.fitBounds(bounds, { padding: [padding, padding], maxZoom: 17, animate: false });
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

        /* ---------------------------------------------------- provider chain */
        const mountProvider = (): void => {
          if (!map || disposed) return;
          providerCleanup?.();
          providerCleanup = null;

          const provider = TILE_PROVIDERS[providerIndex];
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
          });

          const layer = L.tileLayer(provider.url, {
            maxZoom: provider.maxZoom,
            attribution: provider.attribution,
            subdomains: provider.subdomains ?? 'abc',
            crossOrigin: true,
            errorTileUrl: TRANSPARENT_TILE,
            keepBuffer: 2,
          });
          layer.addTo(map);

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
            layer.off();
            layer.remove();
            providerIndex = nextIndex;
            const next = TILE_PROVIDERS[providerIndex];
            if (next) {
              publish({ id: next.id, label: next.label, status: 'fallback' });
              mountProvider();
            } else {
              failBasemap(
                'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
              );
            }
          };

          const advance = () => {
            if (providerIndex >= TILE_PROVIDERS.length - 1) {
              failBasemap(
                'Basemap tiles could not be loaded from any provider. Coordinate entry, tables and uploaded data still work.',
              );
              return;
            }
            switchTo(nextProviderIndex(providerIndex));
          };

          timeout = window.setTimeout(() => {
            if (!switched && loadedTiles === 0) advance();
          }, PROVIDER_TIMEOUT_MS);

          layer.on('tileload', () => {
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
              });
            }
            // Replay a fit request once the basemap proves alive so the ring is
            // framed correctly even if the first fit ran against an empty size.
            if (!refitAfterTiles) {
              refitAfterTiles = true;
              if (pendingFit) requestFit();
            }
          });

          layer.on('tileerror', () => {
            if (switched) return;
            errorsSinceLoad += 1;
            const action = evaluateTileHealth({ loadedTiles, errorsSinceLoad }, providerIndex);
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
            layer.off();
            layer.remove();
          };
        };

        mountProvider();

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
            'The map library could not be loaded. Coordinate entry, tables and uploaded data still work.',
          );
        }
      }
    })();

    return () => {
      disposed = true;
      initialisingRef.current = false;
      themeObserver?.disconnect();
      resizeCleanup?.();
      providerCleanup?.();
      lineLayerRef.current?.remove();
      polygonLayerRef.current?.remove();
      markerLayerRef.current = null;
      lineLayerRef.current = null;
      polygonLayerRef.current = null;
      map?.remove();
      mapRef.current = null;
      leafletRef.current = null;
    };
  }, []);

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

  const basemapText =
    basemap.status === 'loading'
      ? `Basemap: ${basemap.label} — loading tiles…`
      : basemap.status === 'ok'
        ? `Basemap: ${basemap.label}`
        : basemap.status === 'fallback'
          ? `Fallback basemap: ${basemap.label}`
          : `Basemap failed: ${basemap.label} — coordinate entry still works`;

  return (
    <div
      className={cx('map-shell', className)}
      data-mode={mode}
      data-basemap-status={basemap.status}
      data-basemap-provider={basemap.id}
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
        <div className="map-overlay map-overlay--tl">
          <div className="map-hud" aria-live="polite">
            Loading basemap…
          </div>
        </div>
      ) : null}
      {failure ? (
        <div className="map-fallback">
          <div className="map-fallback__panel" role="status">
            <strong>Map unavailable</strong>
            <p>{failure}</p>
          </div>
        </div>
      ) : null}
      {children}
    </div>
  );
}
