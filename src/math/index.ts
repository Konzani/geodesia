/**
 * Geodesia — mathematical core public surface
 * ---------------------------------------------------------------------------
 * Re-exports the frozen contract in `./types` together with the concrete
 * implementations. Import everything from `src/math` (or `@/math`): the
 * declaration-only `types.ts` carries types, the sibling modules carry the
 * runtime values.
 */
export type {
  LatLon,
  XYPoint,
  Vertex,
  LengthUnit,
  AreaUnits,
  Ellipsoid,
  AreaMode,
  AreaSegment,
  AreaResult,
  UnitGroup,
  AreaUnitDef,
  ConversionRow,
  TerrainSample,
  TerrainCategory,
  SlopeSegment,
  TerrainResult,
  TerrainOptions,
  TabularData,
  TerrainColumnRole,
  TerrainColumnMap,
  TerrainIngestResult,
} from './types';

export {
  WGS84,
  parseDMS,
  formatDMS,
  formatDD,
  geodesicInverse,
  geodesicDirect,
  geodesicPath,
  geodesicPolylinePath,
  geodesicPolygonArea,
} from './geodesy';

export { signedArea, shoelaceArea, perimeter2D, centroid2D } from './shoelace';

export { computePolygonArea, toAreaUnits } from './area';

export { AREA_UNITS, findAreaUnit, convertArea, convertAll, areaFromDimensions } from './units';

export { TERRAIN_THRESHOLDS, classifySlope, computeTerrainProfile } from './terrain';

export {
  parseDelimitedText,
  parseSpreadsheet,
  detectTerrainColumns,
  ingestTerrainRows,
  buildProfileFromPath,
} from './parse';

export { fmtNumber, fmtArea, fmtLength, fmtSigned } from './format';
