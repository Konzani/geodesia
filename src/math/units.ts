/**
 * Geodesia — land-area units
 * ---------------------------------------------------------------------------
 * Every supported land-area unit, expressed as an exact (or conventionally
 * exact) conversion factor to square metres.
 *
 * Factors:
 *   1 m²      = 1 m²
 *   1 are     = 100 m²
 *   1 hectare = 10 000 m²
 *   1 km²     = 1 000 000 m²
 *   1 ft²     = 0.09290304 m²            (1 ft = 0.3048 m exactly)
 *   1 yd²     = 0.83612736 m²            (1 yd = 0.9144 m exactly)
 *   1 acre    = 4046.8564224 m²          (international acre)
 *   1 mile²   = 2 589 988.110336 m²      (640 acres)
 *   1 rood    = 1011.7141056 m²          (¼ acre)
 *   1 gunta   = 101.17141056 m²          (1/40 acre, East African cadastral)
 *   1 decimal = 40.468564224 m²          (1/100 acre, East African usage)
 *
 * Pure functions only. Unknown units and non-finite values throw an `Error`.
 */
import type { AreaUnitDef, AreaUnits, ConversionRow, UnitGroup } from './types';

const ACRE_M2 = 4046.8564224;

/** Every supported land-area unit. */
export const AREA_UNITS: AreaUnitDef[] = [
  { id: 'm2', label: 'Square metres', symbol: 'm²', factor: 1, group: 'metric' },
  { id: 'ares', label: 'Ares', symbol: 'a', factor: 100, group: 'metric' },
  { id: 'ha', label: 'Hectares', symbol: 'ha', factor: 10000, group: 'metric' },
  { id: 'km2', label: 'Square kilometres', symbol: 'km²', factor: 1000000, group: 'metric' },
  { id: 'ft2', label: 'Square feet', symbol: 'ft²', factor: 0.09290304, group: 'imperial' },
  { id: 'yd2', label: 'Square yards', symbol: 'yd²', factor: 0.83612736, group: 'imperial' },
  { id: 'acres', label: 'Acres', symbol: 'ac', factor: ACRE_M2, group: 'imperial' },
  { id: 'mi2', label: 'Square miles', symbol: 'mi²', factor: 2589988.110336, group: 'imperial' },
  {
    id: 'roods',
    label: 'Roods',
    symbol: 'rood',
    factor: ACRE_M2 / 4,
    group: 'cadastral',
    note: 'Quarter of an acre; still quoted on older Kenyan title deeds.',
  },
  {
    id: 'guntas',
    label: 'Guntas',
    symbol: 'gunta',
    factor: ACRE_M2 / 40,
    group: 'agricultural',
    note: '1/40 acre (101.17 m²), common in Kenyan agricultural plots.',
  },
  {
    id: 'decimals',
    label: 'Decimals',
    symbol: 'dec',
    factor: ACRE_M2 / 100,
    group: 'agricultural',
    note: '1/100 acre (40.47 m²), used in East African land transactions.',
  },
];

const UNIT_BY_ID: ReadonlyMap<string, AreaUnitDef> = new Map(
  AREA_UNITS.map((unit) => [unit.id.toLowerCase(), unit]),
);

/** Look up a unit definition by id (case-insensitive). Throws for unknown ids. */
export function findAreaUnit(id: string): AreaUnitDef {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new Error('A land-area unit id is required.');
  }
  const unit = UNIT_BY_ID.get(id.trim().toLowerCase());
  if (!unit) {
    const known = AREA_UNITS.map((entry) => entry.id).join(', ');
    throw new Error(`Unknown land-area unit "${id}". Known units: ${known}.`);
  }
  return unit;
}

function assertFiniteValue(value: number, label = 'value'): void {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number.`);
  }
}

/** Convert `value` from one unit id to another. */
export function convertArea(value: number, from: string, to: string): number {
  assertFiniteValue(value);
  const source = findAreaUnit(from);
  const target = findAreaUnit(to);
  const squareMetres = value * source.factor;
  const converted = squareMetres / target.factor;
  return Object.is(converted, -0) ? 0 : converted;
}

/** Convert into every supported unit, ordered by unit magnitude (smallest first). */
export function convertAll(value: number, from: string): ConversionRow[] {
  assertFiniteValue(value);
  const source = findAreaUnit(from);
  const squareMetres = value * source.factor;
  return [...AREA_UNITS]
    .sort((left, right) => left.factor - right.factor)
    .map((unit) => ({
      unit: unit.id,
      label: unit.label,
      symbol: unit.symbol,
      value: squareMetres / unit.factor,
      group: unit.group as UnitGroup,
    }));
}

/** Area in square metres of a rectangular parcel given in metres or feet. */
export function areaFromDimensions(width: number, length: number, unit: 'm' | 'ft'): number {
  assertFiniteValue(width, 'width');
  assertFiniteValue(length, 'length');
  if (width < 0 || length < 0) {
    throw new Error('width and length must be greater than or equal to 0.');
  }
  if (unit !== 'm' && unit !== 'ft') {
    throw new Error('unit must be "m" or "ft".');
  }
  const factor = unit === 'ft' ? 0.3048 : 1;
  const metres = width * factor * length * factor;
  return metres;
}

/** Convert a square-metre magnitude into the full unit set. */
export function toAreaUnits(m2: number): AreaUnits {
  assertFiniteValue(m2, 'Area in square metres');
  return {
    m2,
    ha: m2 / findAreaUnit('ha').factor,
    acres: m2 / findAreaUnit('acres').factor,
    km2: m2 / findAreaUnit('km2').factor,
    ft2: m2 / findAreaUnit('ft2').factor,
    roods: m2 / findAreaUnit('roods').factor,
    guntas: m2 / findAreaUnit('guntas').factor,
  };
}
