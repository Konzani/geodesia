/**
 * GEODESIA — basemap provider-chain health rules.
 *
 * The pure decision logic behind `MapCanvas`'s automatic tile fallback, kept
 * separate so it can be unit-tested without a DOM or network. `MapCanvas` feeds
 * it the live tile counters after every `tileload` / `tileerror`.
 */
import { TILE_PROVIDERS } from './basemap';

/** Errors a provider may accumulate before it is abandoned. */
export const TILE_ERROR_THRESHOLD = 4;

export type TileAction = 'wait' | 'switch' | 'fail';

export interface TileHealth {
  loadedTiles: number;
  /** Errors accumulated since the last successfully loaded tile. */
  errorsSinceLoad: number;
}

/**
 * Decide what to do with the current provider.
 *
 * - No errors, or errors below the threshold → keep waiting (`wait`).
 * - A provider that never loaded a tile and accumulates `TILE_ERROR_THRESHOLD`
 *   errors is abandoned (`switch`), or reported as failed if it was the last one.
 * - A provider that loaded tiles but then accumulates twice the threshold is
 *   considered degraded and switched off as well.
 */
export function evaluateTileHealth(
  health: TileHealth,
  providerIndex: number,
  providerCount: number = TILE_PROVIDERS.length,
): TileAction {
  if (!Number.isFinite(providerIndex) || !Number.isFinite(providerCount) || providerCount <= 0) {
    return 'fail';
  }
  const { loadedTiles, errorsSinceLoad } = health;
  if (errorsSinceLoad <= 0) return 'wait';
  const hasNext = providerIndex < providerCount - 1;
  if (loadedTiles <= 0) {
    if (errorsSinceLoad < TILE_ERROR_THRESHOLD) return 'wait';
    return hasNext ? 'switch' : 'fail';
  }
  if (errorsSinceLoad < TILE_ERROR_THRESHOLD * 2) return 'wait';
  return hasNext ? 'switch' : 'fail';
}

/** Index of the next provider in the chain (clamped to the last entry). */
export function nextProviderIndex(providerIndex: number, providerCount: number = TILE_PROVIDERS.length): number {
  if (providerCount <= 0) return 0;
  return Math.min(providerIndex + 1, providerCount - 1);
}

/** Source label for the map status line. */
export function providerLabel(providerIndex: number): string {
  return TILE_PROVIDERS[providerIndex]?.label ?? 'Basemap';
}
