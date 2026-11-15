import { describe, expect, it } from 'vitest';
import { ELEVATION_ENDPOINTS, TILE_PROVIDERS } from '../basemap';
import {
  TILE_ERROR_THRESHOLD,
  evaluateTileHealth,
  nextProviderIndex,
  providerLabel,
} from '../basemap-chain';

describe('tile provider chain', () => {
  it('starts with the Geodesia edge worker and falls back in the declared order', () => {
    expect(TILE_PROVIDERS.length).toBeGreaterThanOrEqual(2);
    expect(TILE_PROVIDERS[0]?.primary).toBe(true);
    expect(TILE_PROVIDERS[0]?.url).toContain('geodesia-proxy.254konzani.workers.dev');
    expect(TILE_PROVIDERS.some((provider) => provider.url.includes('openstreetmap.org'))).toBe(true);
    // Every provider carries an attribution so Leaflet always credits the source.
    for (const provider of TILE_PROVIDERS) {
      expect(provider.attribution.length).toBeGreaterThan(10);
    }
  });

  it('waits while a provider is loading or below the error threshold', () => {
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: 0 }, 0)).toBe('wait');
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: TILE_ERROR_THRESHOLD - 1 }, 0)).toBe(
      'wait',
    );
    expect(evaluateTileHealth({ loadedTiles: 5, errorsSinceLoad: 1 }, 0)).toBe('wait');
  });

  it('switches to the next provider after repeated errors', () => {
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: TILE_ERROR_THRESHOLD }, 0)).toBe(
      'switch',
    );
    // A provider that had loaded tiles but then degrades also falls through.
    expect(evaluateTileHealth({ loadedTiles: 3, errorsSinceLoad: TILE_ERROR_THRESHOLD * 2 }, 1)).toBe(
      'switch',
    );
  });

  it('reports failure when the last provider keeps erroring', () => {
    const last = TILE_PROVIDERS.length - 1;
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: TILE_ERROR_THRESHOLD }, last)).toBe(
      'fail',
    );
    expect(
      evaluateTileHealth({ loadedTiles: 2, errorsSinceLoad: TILE_ERROR_THRESHOLD * 2 }, last),
    ).toBe('fail');
  });

  it('walks the provider indexes without overrunning the chain', () => {
    expect(nextProviderIndex(0, 3)).toBe(1);
    expect(nextProviderIndex(1, 3)).toBe(2);
    expect(nextProviderIndex(2, 3)).toBe(2);
    expect(providerLabel(0)).toBe(TILE_PROVIDERS[0]?.label);
  });
});

describe('elevation endpoint chain', () => {
  it('tries the Geodesia edge worker before Open-Meteo', () => {
    expect(ELEVATION_ENDPOINTS.length).toBeGreaterThanOrEqual(2);
    expect(ELEVATION_ENDPOINTS[0]).toContain('geodesia-proxy.254konzani.workers.dev');
    expect(ELEVATION_ENDPOINTS[1]).toContain('api.open-meteo.com');
  });
});
