import { describe, expect, it } from 'vitest';
import {
  AREA_UNITS,
  areaFromDimensions,
  convertAll,
  convertArea,
  findAreaUnit,
  fmtArea,
  fmtLength,
  fmtNumber,
  fmtSigned,
} from '../index';

describe('units', () => {
  it('exposes exact conversion factors for each unit', () => {
    expect(findAreaUnit('m2').factor).toBe(1);
    expect(findAreaUnit('ha').factor).toBe(10000);
    expect(findAreaUnit('km2').factor).toBe(1000000);
    expect(findAreaUnit('ares').factor).toBe(100);
    expect(findAreaUnit('acres').factor).toBeCloseTo(4046.8564224, 12);
    expect(findAreaUnit('ft2').factor).toBe(0.09290304);
    expect(findAreaUnit('yd2').factor).toBe(0.83612736);
    expect(findAreaUnit('mi2').factor).toBeCloseTo(2589988.110336, 9);
    // 1 gunta is 1/40 acre (≈101.171 m²), 1 rood is 1/4 acre (≈1011.714 m²).
    expect(findAreaUnit('guntas').factor).toBeCloseTo(101.171, 2);
    expect(findAreaUnit('guntas').factor).toBeCloseTo(101.17141056, 12);
    expect(findAreaUnit('roods').factor).toBeCloseTo(1011.714, 2);
    expect(findAreaUnit('roods').factor).toBeCloseTo(1011.7141056, 12);
    expect(findAreaUnit('decimals').factor).toBeCloseTo(40.468564224, 12);
    expect(AREA_UNITS.map((unit) => unit.id)).toContain('guntas');
    expect(AREA_UNITS.map((unit) => unit.id)).toContain('roods');
  });

  it('converts between units', () => {
    expect(convertArea(1, 'ha', 'm2')).toBe(10000);
    expect(convertArea(1, 'acres', 'm2')).toBeCloseTo(4046.8564224, 9);
    expect(convertArea(1, 'guntas', 'm2')).toBeCloseTo(101.17141056, 9);
    expect(convertArea(1, 'roods', 'm2')).toBeCloseTo(1011.7141056, 9);
    expect(convertArea(10000, 'm2', 'ha')).toBe(1);
    expect(convertArea(1, 'km2', 'ha')).toBeCloseTo(100, 12);
    expect(convertArea(2.5, 'acres', 'roods')).toBeCloseTo(10, 12);
    // Round trip.
    const roundTrip = convertArea(convertArea(12345.678, 'm2', 'acres'), 'acres', 'm2');
    expect(roundTrip).toBeCloseTo(12345.678, 9);
  });

  it('converts into every unit ordered by magnitude', () => {
    const rows = convertAll(10000, 'm2');
    expect(rows).toHaveLength(AREA_UNITS.length);
    const factors = rows.map((row) => findAreaUnit(row.unit).factor);
    for (let i = 1; i < factors.length; i += 1) {
      expect(factors[i]).toBeGreaterThan(factors[i - 1]);
    }
    expect(rows[0].unit).toBe('ft2');
    const hectareRow = rows.find((row) => row.unit === 'ha');
    expect(hectareRow?.value).toBeCloseTo(1, 12);
    expect(hectareRow?.label).toBe('Hectares');
    expect(hectareRow?.group).toBe('metric');
  });

  it('computes parcel area from width and length', () => {
    expect(areaFromDimensions(10, 10, 'm')).toBe(100);
    expect(areaFromDimensions(10, 10, 'ft')).toBeCloseTo(9.290304, 12);
    expect(areaFromDimensions(100, 50, 'm')).toBe(5000);
    expect(() => areaFromDimensions(-1, 10, 'm')).toThrow(/greater than or equal to 0/);
    expect(() => areaFromDimensions(1, 1, 'yd' as 'm')).toThrow(/unit must be/);
  });

  it('rejects unknown units and non-finite values', () => {
    expect(() => convertArea(1, 'ha', 'furlongs')).toThrow(/Unknown land-area unit/);
    expect(() => convertArea(Number.NaN, 'ha', 'm2')).toThrow(/finite/);
    expect(() => findAreaUnit('')).toThrow(/unit id/);
  });
});

describe('format', () => {
  it('formats numbers with grouping and fixed decimals', () => {
    expect(fmtNumber(1234.5678, 2)).toBe('1,234.57');
    expect(fmtNumber(1234567.891, 0)).toBe('1,234,568');
    expect(fmtNumber(-1234.5, 1)).toBe('-1,234.5');
    expect(fmtNumber(0, 2)).toBe('0.00');
    expect(fmtNumber(-0.004, 2)).toBe('0.00');
    expect(fmtNumber(Number.NaN)).toBe('—');
    expect(fmtNumber(Number.POSITIVE_INFINITY)).toBe('—');
    expect(() => fmtNumber(1, -1)).toThrow(/decimals/);
  });

  it('formats areas in the requested unit', () => {
    expect(fmtArea(10000)).toBe('10,000.00 m²');
    expect(fmtArea(10000, 'ha')).toBe('1.0000 ha');
    expect(fmtArea(4046.8564224, 'acres')).toBe('1.0000 ac');
    expect(fmtArea(101.17141056, 'guntas')).toBe('1.00 gunta');
    expect(fmtArea(1011.7141056, 'roods')).toBe('1.00 rood');
    expect(fmtArea(Number.NaN)).toBe('—');
    expect(() => fmtArea(1, 'furlongs')).toThrow(/Unknown/);
  });

  it('formats lengths in the requested unit', () => {
    expect(fmtLength(500, 'm')).toBe('500.00 m');
    expect(fmtLength(1234.5, 'km')).toBe('1.23 km');
    expect(fmtLength(1, 'ft')).toBe('3.28 ft');
    expect(fmtLength(1609.344, 'mi')).toBe('1.00 mi');
    expect(fmtLength(1852, 'nm')).toBe('1.00 nm');
    expect(fmtLength(Number.NaN)).toBe('—');
  });

  it('formats signed deltas', () => {
    expect(fmtSigned(12.4)).toBe('+12.40');
    expect(fmtSigned(-3.1)).toBe('-3.10');
    expect(fmtSigned(0)).toBe('0.00');
    expect(fmtSigned(-0.001, 2)).toBe('0.00');
    expect(fmtSigned(Number.NaN)).toBe('—');
  });
});
