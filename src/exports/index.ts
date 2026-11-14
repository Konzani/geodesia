/**
 * GEODESIA — EXPORT PIPELINE (client-side)
 * ===========================================================================
 * Runtime implementation of the frozen contract in `./types.ts`.
 *
 * Design rules (non-negotiable):
 *  - Everything is generated in the browser. No network, no server.
 *  - CSV is UTF-8 + BOM with RFC 4180 quoting so Excel opens it cold, and
 *    optional `#`-prefixed comment lines that Excel keeps as text while
 *    documenting the tool, the parameters and the generation timestamp.
 *  - JSON is a verification document: fixed schema envelope, stable key order
 *    (insertion order is the contract order — never re-sort), 2-space indent.
 *  - PDF (pdf-lib) is re-exported from `./pdf.ts`; `pdf-lib` itself is only
 *    ever imported dynamically inside `buildPDF` so it never enters an
 *    island's initial bundle.
 *
 * Consumers must import the runtime API from this module (`src/exports`),
 * and types from `./types`. `./types` is the frozen contract and declares
 * no runtime values.
 */

import type { ExportColumn, ExportRow, VerificationEnvelope } from './types';

/* Re-export the frozen contract types for consumer convenience. */
export type {
  ExportColumn,
  ExportRow,
  ExportMeta,
  PdfSection,
  PdfReportSpec,
  VerificationEnvelope,
} from './types';

/* PDF report rendering lives in its own module (kept dependency-free at the
 * module scope so the pdf-lib chunk stays lazy — see pdf.ts). */
export { buildPDF, exportPDF } from './pdf';

/* ------------------------------------------------------------------------- */
/* constants                                                                  */
/* ------------------------------------------------------------------------- */

const UTF8_BOM = '\uFEFF';
const CSV_MIME = 'text/csv;charset=utf-8';
const JSON_MIME = 'application/json;charset=utf-8';

const ENGINE = {
  name: 'Geodesia',
  url: 'https://geodesia.online',
  datum: 'WGS 84',
  ellipsoid: 'WGS 84 (a = 6378137 m, 1/f = 298.257223563)',
} as const;

/* ------------------------------------------------------------------------- */
/* timestamps + filenames                                                     */
/* ------------------------------------------------------------------------- */

/**
 * ISO-8601 UTC timestamp at second precision, e.g. `2026-11-15T00:04:40Z`.
 * Every artefact carries one so a field report can be reproduced.
 */
export function timestamp(date: Date = new Date()): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Suggested filename: `geodesia-<slug>-2026-11-15T00-04-40Z.<ext>`.
 * The ISO stamp is used verbatim except for `:` (illegal on Windows/macOS).
 */
export function exportFilename(slug: string, ext: string, date: Date = new Date()): string {
  const stamp = timestamp(date).replace(/:/g, '-');
  const suffix = ext.replace(/^\.+/, '').toLowerCase() || 'dat';
  return `geodesia-${slugify(slug) || 'report'}-${stamp}.${suffix}`;
}

/** Lower-case kebab slug, diacritics folded, bounded length. */
function slugify(input: string): string {
  return String(input)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

/* ------------------------------------------------------------------------- */
/* downloading primitives                                                     */
/* ------------------------------------------------------------------------- */

/**
 * Trigger a browser download of `blob` under `filename`.
 *
 * No-op outside the browser (SSR / tests) so the same call sites can run in
 * Node without a DOM shim. The object URL is revoked on the next macrotask,
 * after the browser has committed the navigation to the download.
 */
export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  if (typeof URL.createObjectURL !== 'function') return;

  const href = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';

  const parent = document.body ?? document.documentElement;
  if (!parent) {
    URL.revokeObjectURL(href);
    return;
  }

  parent.appendChild(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    const revoke = (): void => URL.revokeObjectURL(href);
    if (typeof window !== 'undefined') window.setTimeout(revoke, 4000);
    else revoke();
  }
}

/* ------------------------------------------------------------------------- */
/* CSV                                                                        */
/* ------------------------------------------------------------------------- */

/**
 * Build (but do not download) a CSV Blob.
 *
 * Layout: UTF-8 BOM, zero or more `#`-comment lines (tool / parameters /
 * timestamp), then the header row and data rows, CRLF-terminated per RFC 4180.
 * The unit declared on a column is folded into the header label
 * (`Elevation (m)`) so a sheet opened cold is self-describing.
 */
export function buildCSVBlob(
  columns: ExportColumn[],
  rows: ExportRow[],
  headerLines: string[] = [],
): Blob {
  const lines: string[] = [];

  for (const raw of headerLines) {
    const line = String(raw ?? '')
      .replace(/[\r\n]+/g, ' ')
      .trim();
    if (!line) continue;
    lines.push(line.startsWith('#') ? line : `# ${line}`);
  }

  const labels = columns.map((column) => {
    const label = column.label ?? '';
    return escapeCSVCell(column.unit ? `${label} (${column.unit})` : label);
  });
  lines.push(labels.join(','));

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => escapeCSVCell(cellText(row[column.key])))
        .join(','),
    );
  }

  return new Blob([`${UTF8_BOM}${lines.join('\r\n')}\r\n`], { type: CSV_MIME });
}

/** Download a CSV through the browser. */
export function exportCSV(
  filename: string,
  columns: ExportColumn[],
  rows: ExportRow[],
  headerLines: string[] = [],
): void {
  downloadBlob(filename, buildCSVBlob(columns, rows, headerLines));
}

/** RFC 4180 field quoting: wrap when the value contains a delimiter, a quote
 *  or a line break (or leading/trailing whitespace Excel would otherwise eat);
 *  inner quotes are doubled. */
function escapeCSVCell(value: string): string {
  if (/[",\r\n]/.test(value) || /^\s|\s$/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** CSV scalar form. `null`/`undefined` and non-finite numbers are blank so the
 *  sheet stays clean (rather than leaking `NaN` into a report). */
function cellText(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : '';
  }
  return String(value);
}

/* ------------------------------------------------------------------------- */
/* JSON                                                                       */
/* ------------------------------------------------------------------------- */

/**
 * Build a JSON Blob: 2-space indent, insertion (schema) key order preserved.
 * `JSON.stringify` is deterministic for a given object, so the envelope is
 * byte-stable across runs when `generatedAt` is pinned.
 */
export function buildJSONBlob(payload: unknown): Blob {
  return new Blob([JSON.stringify(payload, null, 2)], { type: JSON_MIME });
}

/** Download a JSON document through the browser. */
export function exportJSON(filename: string, payload: unknown): void {
  downloadBlob(filename, buildJSONBlob(payload));
}

/* ------------------------------------------------------------------------- */
/* verification envelope                                                      */
/* ------------------------------------------------------------------------- */

/**
 * Assemble the standard verification document for a JSON export.
 * Key order matches `VerificationEnvelope` in the frozen contract exactly;
 * do not sort.
 */
export function buildVerification<T>(
  args: {
    tool: string;
    title: string;
    method: string;
    parameters?: Record<string, string | number>;
    notes?: string[];
    generatedAt?: Date;
  },
  results: T,
): VerificationEnvelope<T> {
  return {
    schema: 'geodesia.report/v1',
    tool: args.tool,
    title: args.title,
    generatedAt: timestamp(args.generatedAt),
    engine: {
      name: ENGINE.name,
      url: ENGINE.url,
      datum: ENGINE.datum,
      ellipsoid: ENGINE.ellipsoid,
      method: args.method,
    },
    parameters: { ...(args.parameters ?? {}) },
    results,
    notes: [...(args.notes ?? [])],
  };
}
