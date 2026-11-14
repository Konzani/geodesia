/**
 * Geodesia — display formatting
 * ---------------------------------------------------------------------------
 * One place for every user-visible number: grouped integers, fixed decimals,
 * area/length unit suffixes and signed deltas. UI readouts and export files
 * both call these so the same value never renders two different ways.
 *
 * Non-finite inputs render as an em dash (`—`) instead of throwing: they are
 * expected in partially loaded / failed-elevation states and the UI still needs
 * to render. Invalid configuration (unknown unit, bad decimals) throws.
 */
import type { LengthUnit } from './types';
import { findAreaUnit } from './units';

const EM_DASH = '—';

/** Decimals used per land-area unit in display contexts. */
const AREA_DECIMALS: Readonly<Record<string, number>> = {
  m2: 2,
  ares: 2,
  ha: 4,
  km2: 4,
  ft2: 2,
  yd2: 2,
  acres: 4,
  mi2: 4,
  roods: 2,
  guntas: 2,
  decimals: 2,
};

const LENGTH_FACTORS: Readonly<Record<LengthUnit, number>> = {
  m: 1,
  km: 1000,
  ft: 0.3048,
  mi: 1609.344,
  nm: 1852,
};

const LENGTH_DECIMALS: Readonly<Record<LengthUnit, number>> = {
  m: 2,
  km: 2,
  ft: 2,
  mi: 2,
  nm: 2,
};

const LENGTH_SYMBOLS: Readonly<Record<LengthUnit, string>> = {
  m: 'm',
  km: 'km',
  ft: 'ft',
  mi: 'mi',
  nm: 'nm',
};

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 12) {
    throw new Error('decimals must be an integer between 0 and 12.');
  }
}

/** Group the integer part of a plain decimal string with comma separators. */
function groupIntegerPart(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatFixed(value: number, decimals: number): string {
  const rounded = Number(value.toFixed(decimals));
  const negative = rounded < 0;
  const fixed = Math.abs(rounded).toFixed(decimals);
  if (!/^\d/.test(fixed)) return EM_DASH; // toFixed fell back to exponent form
  const [integerPart, fractionPart] = fixed.split('.');
  const grouped = groupIntegerPart(integerPart);
  const text = fractionPart === undefined ? grouped : `${grouped}.${fractionPart}`;
  return negative ? `-${text}` : text;
}

/** Product-style length symbol for a unit id. */
function resolveLengthUnit(unit: string): LengthUnit {
  const normalised = typeof unit === 'string' ? unit.trim().toLowerCase() : '';
  if (normalised === 'm' || normalised === 'km' || normalised === 'ft' || normalised === 'mi' || normalised === 'nm') {
    return normalised;
  }
  throw new Error(`Unknown length unit "${unit}". Known units: m, km, ft, mi, nm.`);
}

/** Format a number with fixed decimals and thousands separators (`1,234.57`). */
export function fmtNumber(value: number, decimals = 2): string {
  assertDecimals(decimals);
  if (typeof value !== 'number' || !Number.isFinite(value)) return EM_DASH;
  return formatFixed(value, decimals);
}

/** Format a square-metre magnitude in a chosen land-area unit (`1.2500 ha`). */
export function fmtArea(m2: number, unit = 'm2'): string {
  const definition = findAreaUnit(unit);
  if (typeof m2 !== 'number' || !Number.isFinite(m2)) return EM_DASH;
  const decimals = AREA_DECIMALS[definition.id] ?? 2;
  return `${formatFixed(m2 / definition.factor, decimals)} ${definition.symbol}`;
}

/** Format a metre magnitude in a chosen length unit (`1.23 km`). */
export function fmtLength(m: number, unit: LengthUnit = 'm'): string {
  const resolved = resolveLengthUnit(unit);
  if (typeof m !== 'number' || !Number.isFinite(m)) return EM_DASH;
  const value = m / LENGTH_FACTORS[resolved];
  return `${formatFixed(value, LENGTH_DECIMALS[resolved])} ${LENGTH_SYMBOLS[resolved]}`;
}

/** Format a signed delta: `+12.40`, `-3.10`, with no sign on exact zero. */
export function fmtSigned(value: number, decimals = 2): string {
  assertDecimals(decimals);
  if (typeof value !== 'number' || !Number.isFinite(value)) return EM_DASH;
  const rounded = Number(value.toFixed(decimals));
  const text = formatFixed(rounded, decimals);
  return rounded > 0 ? `+${text}` : text;
}
