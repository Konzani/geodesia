/**
 * GEODESIA — elevation client (resilient endpoint chain).
 *
 * Client-side only. Endpoints are tried in order from `basemap.ts`
 * (`ELEVATION_ENDPOINTS`): the Geodesia edge worker first, then Open-Meteo.
 * Requests are batched at the API limit (100 points per call), de-duplicated,
 * cached by rounded coordinate for the session, and retried with backoff across
 * the whole chain. Partial failures are returned as `null` samples so the
 * instrument can interpolate and disclose the gap instead of failing the whole
 * profile.
 *
 * No `window` access at module scope — this module is safe to import during SSR.
 */
import type { LatLon } from '../../math/types';
import { ELEVATION_ENDPOINTS } from './basemap';

/** Batch limit shared by both elevation services. */
export const MAX_POINTS_PER_REQUEST = 100;
const CACHE_LIMIT = 5000;
const CACHE_DECIMALS = 6;
const REQUEST_TIMEOUT_MS = 12_000;
/** Retry rounds per endpoint (each round visits the whole chain once). */
const DEFAULT_RETRIES = 2;

/** Session-lifetime elevation cache, keyed by rounded lat/lon. */
const elevationCache = new Map<string, number>();

export interface ElevationProgress {
  /** Total samples requested. */
  total: number;
  /** Samples resolved so far (cache hits included). */
  completed: number;
  /** Samples that were already cached. */
  fromCache: number;
}

export interface ElevationFetchOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ElevationProgress) => void;
  /** Retry rounds after the initial attempt (default 2). */
  retries?: number;
}

export interface ElevationFetchResult {
  /** Elevation per input point; `null` where no service answered. */
  elevations: Array<number | null>;
  /** Number of batches that failed after all retries. */
  failedBatches: number;
  /** Number of samples served from the session cache. */
  fromCache: number;
  /** Endpoint URL that answered the last successful batch, if any. */
  endpoint: string | null;
}

/** Empty the session elevation cache (used by the tool's "clear cache" action). */
export function clearElevationCache(): void {
  elevationCache.clear();
}

/** Current number of cached elevation samples. */
export function elevationCacheSize(): number {
  return elevationCache.size;
}

/** Human label for an endpoint URL, for the instrument status line. */
export function describeElevationEndpoint(endpoint: string | null): string {
  if (!endpoint) return 'elevation service';
  try {
    const host = new URL(endpoint).hostname;
    if (host.endsWith('workers.dev')) return 'Geodesia edge';
    if (host.includes('open-meteo')) return 'Open-Meteo';
    return host;
  } catch {
    return 'elevation service';
  }
}

function cacheKey(point: LatLon): string {
  return `${point.lat.toFixed(CACHE_DECIMALS)},${point.lon.toFixed(CACHE_DECIMALS)}`;
}

function abortSignalError(): Error {
  const error = new Error('Elevation request cancelled.');
  error.name = 'AbortError';
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortSignalError();
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortSignalError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortSignalError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseElevations(payload: unknown, expected: number): number[] {
  if (typeof payload !== 'object' || payload === null) {
    throw new Error('Elevation service returned an unexpected response.');
  }
  const raw = (payload as { elevation?: unknown }).elevation;
  if (!Array.isArray(raw) || raw.length !== expected) {
    throw new Error('Elevation service returned an incomplete batch.');
  }
  return raw.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : Number.NaN));
}

async function requestBatchFromEndpoint(
  endpoint: string,
  points: ReadonlyArray<LatLon>,
  signal?: AbortSignal,
): Promise<number[]> {
  const latitude = points.map((point) => point.lat.toFixed(6)).join(',');
  const longitude = points.map((point) => point.lon.toFixed(6)).join(',');
  const url = `${endpoint}?latitude=${latitude}&longitude=${longitude}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  signal?.addEventListener('abort', forwardAbort, { once: true });

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) {
      throw new Error(`Elevation service unavailable (HTTP ${response.status}).`);
    }
    const payload: unknown = await response.json();
    return parseElevations(payload, points.length);
  } catch (error) {
    if (signal?.aborted) throw abortSignalError();
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', forwardAbort);
  }
}

function trimCache(): void {
  while (elevationCache.size > CACHE_LIMIT) {
    const oldest = elevationCache.keys().next();
    if (oldest.done) return;
    elevationCache.delete(oldest.value);
  }
}

/**
 * Fetch elevations for a path. Resolves with one entry per input point, in
 * order. Partial results are always returned; the caller decides whether the
 * interpolation gap is acceptable.
 */
export async function fetchElevations(
  points: ReadonlyArray<LatLon>,
  options: ElevationFetchOptions = {},
): Promise<ElevationFetchResult> {
  const { signal, onProgress, retries = DEFAULT_RETRIES } = options;

  if (points.length === 0) {
    return { elevations: [], failedBatches: 0, fromCache: 0, endpoint: null };
  }

  for (const point of points) {
    if (
      !Number.isFinite(point.lat) ||
      !Number.isFinite(point.lon) ||
      point.lat < -90 ||
      point.lat > 90 ||
      point.lon < -180 ||
      point.lon > 180
    ) {
      throw new Error('Elevation sampling needs valid WGS 84 latitudes and longitudes.');
    }
  }

  const elevations: Array<number | null> = new Array(points.length).fill(null);
  let fromCache = 0;

  interface PendingPoint {
    key: string;
    point: LatLon;
    indexes: number[];
  }

  const pending = new Map<string, PendingPoint>();
  points.forEach((point, index) => {
    const key = cacheKey(point);
    const cached = elevationCache.get(key);
    if (cached !== undefined) {
      elevations[index] = cached;
      fromCache += 1;
      return;
    }
    const existing = pending.get(key);
    if (existing) existing.indexes.push(index);
    else pending.set(key, { key, point, indexes: [index] });
  });

  let completed = fromCache;
  onProgress?.({ total: points.length, completed, fromCache });

  if (pending.size === 0) {
    return { elevations, failedBatches: 0, fromCache, endpoint: null };
  }

  const unique = [...pending.values()];
  const batches: PendingPoint[][] = [];
  for (let start = 0; start < unique.length; start += MAX_POINTS_PER_REQUEST) {
    batches.push(unique.slice(start, start + MAX_POINTS_PER_REQUEST));
  }

  const endpoints = ELEVATION_ENDPOINTS.length > 0 ? ELEVATION_ENDPOINTS : [''];
  const attemptsPerBatch = Math.max(1, retries + 1) * endpoints.length;

  let failedBatches = 0;
  let usedEndpoint: string | null = null;

  for (const batch of batches) {
    throwIfAborted(signal);

    let values: number[] | null = null;
    for (let attempt = 0; attempt < attemptsPerBatch; attempt += 1) {
      const endpoint = endpoints[attempt % endpoints.length] ?? endpoints[0];
      try {
        values = await requestBatchFromEndpoint(endpoint, batch.map((entry) => entry.point), signal);
        usedEndpoint = endpoint;
        break;
      } catch {
        if (signal?.aborted) throw abortSignalError();
        if (attempt < attemptsPerBatch - 1) {
          const round = Math.floor(attempt / endpoints.length);
          await delay(350 * 2 ** round, signal);
        }
      }
    }

    if (values) {
      batch.forEach((entry, indexInBatch) => {
        const value = values?.[indexInBatch];
        if (typeof value === 'number' && Number.isFinite(value)) {
          entry.indexes.forEach((pointIndex) => {
            elevations[pointIndex] = value;
          });
          elevationCache.set(entry.key, value);
        }
      });
    } else {
      failedBatches += 1;
    }

    completed = Math.min(
      points.length,
      completed + batch.reduce((sum, entry) => sum + entry.indexes.length, 0),
    );
    onProgress?.({ total: points.length, completed, fromCache });
  }

  trimCache();
  return { elevations, failedBatches, fromCache, endpoint: usedEndpoint };
}
