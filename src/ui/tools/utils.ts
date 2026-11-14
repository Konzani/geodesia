/**
 * GEODESIA — instrument UI helpers.
 *
 * Small, dependency-free utilities shared by the React instruments: class-name
 * composition, clipboard access, token resolution (so Leaflet features are
 * coloured from the design system instead of hardcoded hex), file reading and
 * chart axis tick generation. Nothing here touches `window` at module scope.
 */

export { cx } from '../components/ui/cx';

/** Clamp `value` into the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/** Turn any thrown value into a human-readable message. */
export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'Unexpected error.';
}

/** True when an async operation failed because it was aborted on purpose. */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message)))
  );
}

/**
 * Resolve a CSS custom property to a concrete colour string the Leaflet canvas
 * renderer can use. Leaflet writes SVG presentation attributes, where `var()`
 * is unreliable, so we resolve through a probe element's computed style.
 * Client-only; returns `fallback` during SSR or if the token is unknown.
 */
export function tokenColor(name: string, fallback = 'currentColor'): string {
  if (typeof document === 'undefined' || !document.body) return fallback;
  const probe = document.createElement('span');
  probe.style.display = 'none';
  probe.style.color = `var(${name})`;
  document.body.appendChild(probe);
  try {
    const resolved = getComputedStyle(probe).color;
    return resolved && resolved !== '' && resolved !== 'rgba(0, 0, 0, 0)' ? resolved : fallback;
  } finally {
    probe.remove();
  }
}

/** Read a file as UTF-8 text. */
export function readFileAsText(file: File): Promise<string> {
  return file.text();
}

/** Read a file as an ArrayBuffer (for spreadsheet parsing). */
export function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return file.arrayBuffer();
}

/** Copy text to the clipboard. Falls back to a hidden textarea select+copy. */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    window.isSecureContext
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      /* fall through to the legacy path */
    }
  }
  if (typeof document === 'undefined') return false;
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Replace missing elevation samples by linear interpolation between known
 * neighbours (edge values hold the nearest known elevation). Returns the
 * number filled so the UI can disclose the interpolation honestly.
 */
export function fillMissingElevations(values: ReadonlyArray<number | null>): {
  values: number[];
  filled: number;
} {
  const out: number[] = [];
  let filled = 0;

  let previousKnown = -1;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value !== null && Number.isFinite(value)) {
      previousKnown = i;
      out.push(value);
    } else {
      out.push(Number.NaN);
      filled += 1;
    }
  }

  if (previousKnown === -1) {
    throw new Error('No elevation samples were returned for this line.');
  }

  // Fill from the first known sample outwards, then interpolate interior gaps.
  for (let i = 0; i < previousKnown; i += 1) out[i] = out[previousKnown];
  for (let i = 0; i < out.length; i += 1) {
    if (Number.isFinite(out[i])) continue;
    let next = i + 1;
    while (next < out.length && !Number.isFinite(out[next])) next += 1;
    const left = i - 1 >= 0 ? out[i - 1] : out[previousKnown];
    const right = next < out.length ? out[next] : out[previousKnown];
    const span = next - (i - 1);
    const step = (right - left) / (span === 0 ? 1 : span);
    for (let j = i; j < Math.min(next, out.length); j += 1) {
      out[j] = left + step * (j - (i - 1));
    }
    i = next;
  }

  return { values: out, filled };
}

/** Round to a "nice" 1/2/5 × 10^n step, used by the profile chart axes. */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1;
  const exponent = Math.floor(Math.log10(rough));
  const magnitude = 10 ** exponent;
  const fraction = rough / magnitude;
  let niceFraction: number;
  if (fraction <= 1) niceFraction = 1;
  else if (fraction <= 2) niceFraction = 2;
  else if (fraction <= 5) niceFraction = 5;
  else niceFraction = 10;
  return niceFraction * magnitude;
}

/** Inclusive, evenly stepped ticks covering `[min, max]` at a "nice" interval. */
export function niceTicks(min: number, max: number, targetCount = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) return [min];
  const low = Math.min(min, max);
  const high = Math.max(min, max);
  const step = niceStep((high - low) / Math.max(1, targetCount));
  const first = Math.ceil(low / step) * step;
  const ticks: number[] = [];
  for (let tick = first; tick <= high + step * 1e-9; tick += step) {
    ticks.push(Math.abs(tick) < step * 1e-9 ? 0 : tick);
  }
  return ticks;
}

/** Decimal places that keep a converted area legible across 9 orders of magnitude. */
export function magnitudeDecimals(value: number): number {
  const abs = Math.abs(value);
  if (!Number.isFinite(abs) || abs === 0) return 2;
  if (abs >= 1_000_000) return 0;
  if (abs >= 1000) return 1;
  if (abs >= 10) return 2;
  if (abs >= 1) return 3;
  if (abs >= 0.01) return 4;
  return 6;
}

/** Format bytes for drop-zone metadata. */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** index;
  return `${index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}
