/**
 * GEODESIA — Open-Meteo elevation client.
 *
 * Client-side only: batches requests at the API limit (100 points per call),
 * de-duplicates, caches by rounded coordinate for the session, and retries with
 * backoff. Partial failures are returned as `null` samples so the instrument can
 * interpolate and disclose the gap instead of failing the whole profile.
 *
 * No `window` access at module scope — this module is safe to import during SSR.
 */
import type { LatLon } from '../../math/types';

export const ELEVATION_ENDPOINT = 'https://api.open-meteo.com/v1/elevation';
/** Open-Meteo accepts up to 100 coordinates per elevation request. */
export const MAX_POINTS_PER_REQUEST = 100;
const CACHE_LIMIT = 5000;
const CACHE_DECIMALS = 6;
const REQUEST_TIMEOUT_MS = 12_000;

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
  /** Retries per batch after the initial attempt (default 2). */
  retries?: number;
}

export interface ElevationFetchResult {
  /** Elevation per input point; `null` where the service did not answer. */
  elevations: Array<number | null>;
  /** Number of batches that failed after all retries. */
  failedBatches: number;
  /** Number of samples served from the session cache. */
  fromCache: number;
}

/** Empty the session elevation cache (used by the tool's "clear cache" action). */
export function clearElevationCache(): void {
  elevationCache.clear();
}

/** Current number of cached elevation samples. */
export function elevationCacheSize(): number {
  return elevationCache.size;
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

async function requestBatch(points: ReadonlyArray<LatLon>, signal?: AbortSignal): Promise<number[]> {
  const latitude = points.map((point) => point.lat.toFixed(6)).join(',');
  const longitude = points.map((point) => point.lon.toFixed(6)).join(',');
  const url = `${ELEVATION_ENDPOINT}?latitude=${latitude}&longitude=${longitude}`;

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
 * order. Never rejects for a service failure unless every batch failed and the
 * caller needs to know; partial results are always returned.
 */
export async function fetchElevations(
  points: ReadonlyArray<LatLon>,
  options: ElevationFetchOptions = {},
): Promise<ElevationFetchResult> {
  const { signal, onProgress, retries = 2 } = options;

  if (points.length === 0) {
    return { elevations: [], failedBatches: 0, fromCache: 0 };
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
    return { elevations, failedBatches: 0, fromCache };
  }

  const unique = [...pending.values()];
  const batches: PendingPoint[][] = [];
  for (let start = 0; start < unique.length; start += MAX_POINTS_PER_REQUEST) {
    batches.push(unique.slice(start, start + MAX_POINTS_PER_REQUEST));
  }

  let failedBatches = 0;

  for (const batch of batches) {
    throwIfAborted(signal);

    let values: number[] | null = null;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        values = await requestBatch(
          batch.map((entry) => entry.point),
          signal,
        );
        break;
      } catch {
        if (signal?.aborted) throw abortSignalError();
        if (attempt < retries) await delay(350 * 2 ** attempt, signal);
        else values = null;
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

    completed = Math.min(points.length, completed + batch.reduce((sum, entry) => sum + entry.indexes.length, 0));
    onProgress?.({ total: points.length, completed, fromCache });
  }

  trimCache();
  return { elevations, failedBatches, fromCache };
}
