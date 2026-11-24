import { describe, expect, it } from 'vitest';
import {
  BASEMAP_HOSTS,
  BASEMAP_LAYERS,
  BASEMAP_LAYER_ORDER,
  DEFAULT_BASEMAP_LAYER,
  ELEVATION_ENDPOINTS,
  TILE_PROVIDERS,
  allBasemapProviders,
  resolveBasemapLayer,
} from '../basemap';
import {
  TILE_ERROR_THRESHOLD,
  evaluateTileHealth,
  nextProviderIndex,
  providerCountFor,
  providerLabel,
} from '../basemap-chain';

describe('basemap layers', () => {
  it('opens on satellite imagery for plot-level detail', () => {
    expect(DEFAULT_BASEMAP_LAYER).toBe('satellite');
    expect(BASEMAP_LAYER_ORDER[0]).toBe('satellite');
    const satellite = BASEMAP_LAYERS.satellite;
    expect(satellite.providers[0]?.url).toContain(
      'World_Imagery/MapServer/tile',
    );
    // Imagery must be able to reach the zooms where plots are legible.
    expect(satellite.providers[0]?.maxZoom).toBeGreaterThanOrEqual(18);
  });

  it('offers satellite, terrain and streets, each with its own attribution', () => {
    for (const id of BASEMAP_LAYER_ORDER) {
      const layer = BASEMAP_LAYERS[id];
      expect(layer.providers.length).toBeGreaterThanOrEqual(2);
      expect(layer.label.length).toBeGreaterThan(2);
      expect(layer.hint.length).toBeGreaterThan(10);
      for (const provider of layer.providers) {
        expect(provider.attribution.length).toBeGreaterThan(10);
        expect(provider.maxZoom).toBeGreaterThanOrEqual(17);
        // A provider must never claim more native zoom than its server renders.
        expect(provider.maxNativeZoom ?? provider.maxZoom).toBeLessThanOrEqual(provider.maxZoom);
      }
    }
  });

  it('keeps the Geodesia edge worker in the terrain chain and only there', () => {
    const terrainFirst = BASEMAP_LAYERS.terrain.providers[0];
    expect(terrainFirst?.url).toContain('geodesia-proxy.254konzani.workers.dev');
    expect(terrainFirst?.primary).toBe(true);
    const otherChains = [BASEMAP_LAYERS.satellite, BASEMAP_LAYERS.streets].flatMap((layer) =>
      layer.providers.map((provider) => provider.url),
    );
    expect(otherChains.some((url) => url.includes('geodesia-proxy'))).toBe(false);
  });

  it('draws Esri place labels over the imagery and no overlay on the others', () => {
    expect(BASEMAP_LAYERS.satellite.overlay?.url).toContain('World_Boundaries_and_Places');
    expect(BASEMAP_LAYERS.terrain.overlay).toBeUndefined();
    expect(BASEMAP_LAYERS.streets.overlay).toBeUndefined();
  });

  it('lists every host the CSP and service worker must allow', () => {
    const hosts = allBasemapProviders().map((provider) => new URL(provider.url.replace('{s}', 'a')).hostname);
    for (const host of hosts) {
      const bare = host.replace(/^[a-d]\./, '');
      expect(BASEMAP_HOSTS.includes(host) || BASEMAP_HOSTS.includes(bare)).toBe(true);
    }
    for (const host of BASEMAP_HOSTS) {
      expect(host).not.toMatch(/^https?:/);
    }
  });

  it('resolves a stored layer defensively', () => {
    expect(resolveBasemapLayer('terrain')).toBe('terrain');
    expect(resolveBasemapLayer('streets')).toBe('streets');
    expect(resolveBasemapLayer('nonsense')).toBe(DEFAULT_BASEMAP_LAYER);
    expect(resolveBasemapLayer(null)).toBe(DEFAULT_BASEMAP_LAYER);
    expect(resolveBasemapLayer(undefined)).toBe(DEFAULT_BASEMAP_LAYER);
  });

  it('keeps TILE_PROVIDERS as the default layer chain', () => {
    expect(TILE_PROVIDERS).toBe(BASEMAP_LAYERS[DEFAULT_BASEMAP_LAYER].providers);
  });
});

describe('tile provider chain health', () => {
  it('waits while a provider is loading or below the error threshold', () => {
    expect(providerCountFor('satellite')).toBe(BASEMAP_LAYERS.satellite.providers.length);
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
    const count = providerCountFor('satellite');
    const last = count - 1;
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: TILE_ERROR_THRESHOLD }, last, count)).toBe(
      'fail',
    );
    expect(
      evaluateTileHealth({ loadedTiles: 2, errorsSinceLoad: TILE_ERROR_THRESHOLD * 2 }, last, count),
    ).toBe('fail');
  });

  it('walks the provider indexes without overrunning the chain', () => {
    expect(nextProviderIndex(0, 3)).toBe(1);
    expect(nextProviderIndex(1, 3)).toBe(2);
    expect(nextProviderIndex(2, 3)).toBe(2);
    expect(providerLabel(0, 'terrain')).toBe(BASEMAP_LAYERS.terrain.providers[0]?.label);
  });

  it('fails closed on nonsense chain parameters', () => {
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: 1 }, Number.NaN)).toBe('fail');
    expect(evaluateTileHealth({ loadedTiles: 0, errorsSinceLoad: 1 }, 0, 0)).toBe('fail');
    expect(nextProviderIndex(0, 0)).toBe(0);
  });
});

describe('elevation endpoint chain', () => {
  it('tries the Geodesia edge worker before Open-Meteo', () => {
    expect(ELEVATION_ENDPOINTS.length).toBeGreaterThanOrEqual(2);
    expect(ELEVATION_ENDPOINTS[0]).toContain('geodesia-proxy.254konzani.workers.dev');
    expect(ELEVATION_ENDPOINTS[1]).toContain('api.open-meteo.com');
  });
});
