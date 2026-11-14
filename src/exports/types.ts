/**
 * GEODESIA — EXPORT PIPELINE CONTRACT (`/src/exports/`)
 * ---------------------------------------------------------------------------
 * All exports are generated client-side. No server, no network.
 *
 * Design rules
 *  - Every export is a deliberate, engineering-grade artefact: it carries the
 *    tool name, the geodesia.online attribution, and an ISO-8601 timestamp.
 *  - CSV columns are declared by the caller (label + unit) so the sheet is
 *    self-describing when opened cold in Excel.
 *  - JSON is a verification document: stable top-level keys, no undefined.
 *  - PDF (pdf-lib) mirrors the on-screen engineering report.
 *
 * NOTE: declarations here are ambient (`declare`) — this module carries types
 * only. Runtime implementations live in `index.ts` / `pdf.ts` and are re-exported
 * from the directory barrel.
 */

export interface ExportColumn {
  key: string;
  label: string;
  unit?: string;
}

export type ExportRow = Record<string, string | number | null | undefined>;

export interface ExportMeta {
  /** Tool display name, e.g. "Terrain Profile". */
  tool: string;
  /** Page/report title. */
  title: string;
  /** Sub-headline under the title. */
  subtitle?: string;
  /** When the computation ran (defaults to now). */
  generatedAt?: Date;
  /** Key/value inputs so the report can be reproduced. */
  parameters?: Array<{ label: string; value: string | number }>;
  /** Free-form engineering notes printed at the end of a PDF. */
  notes?: string[];
}

/* ------------------------------------------------------------------------- */
/* downloading primitives                                                     */
/* ------------------------------------------------------------------------- */

/** Trigger a browser download of a Blob under `filename`. */
export declare function downloadBlob(filename: string, blob: Blob): void;

/** Build (but do not download) a CSV Blob with UTF-8 BOM + RFC 4180 quoting. */
export declare function buildCSVBlob(
  columns: ExportColumn[],
  rows: ExportRow[],
  headerLines?: string[],
): Blob;

/** Download a CSV through the browser. */
export declare function exportCSV(
  filename: string,
  columns: ExportColumn[],
  rows: ExportRow[],
  headerLines?: string[],
): void;

/** Build a JSON verification Blob (2-space indent, stable key order). */
export declare function buildJSONBlob(payload: unknown): Blob;

/** Download a JSON document through the browser. */
export declare function exportJSON(filename: string, payload: unknown): void;

/* ------------------------------------------------------------------------- */
/* PDF (pdf-lib)                                                              */
/* ------------------------------------------------------------------------- */

export type PdfSection =
  | {
      kind: 'kv';
      heading: string;
      rows: Array<{ label: string; value: string; emphasis?: boolean }>;
    }
  | {
      kind: 'table';
      heading: string;
      columns: Array<{ label: string; align?: 'left' | 'right'; unit?: string }>;
      rows: Array<Array<string | number>>;
      /** Optional totals/verification line printed under the table. */
      footnote?: string;
    }
  | { kind: 'text'; heading: string; paragraphs: string[] }
  | { kind: 'notes'; heading: string; lines: string[] };

export interface PdfReportSpec {
  meta: ExportMeta;
  /** Optional SVG data-URL of the computed chart to embed. */
  chartSvg?: string;
  sections: PdfSection[];
  /** Override the document title metadata. */
  documentTitle?: string;
}

/** Generate and download a client-side PDF report (pdf-lib, A4 portrait). */
export declare function exportPDF(spec: PdfReportSpec): Promise<void>;

/** Build the PDF but return bytes (used by tests / previews). */
export declare function buildPDF(spec: PdfReportSpec): Promise<Uint8Array>;

/* ------------------------------------------------------------------------- */
/* payload builders (structured verification documents)                       */
/* ------------------------------------------------------------------------- */

export interface VerificationEnvelope<T = unknown> {
  schema: 'geodesia.report/v1';
  tool: string;
  title: string;
  generatedAt: string;
  engine: {
    name: 'Geodesia';
    url: 'https://geodesia.online';
    datum: 'WGS 84';
    ellipsoid: string;
    method: string;
  };
  parameters: Record<string, string | number>;
  results: T;
  notes: string[];
}

/** Assemble the standard verification envelope for a JSON export. */
export declare function buildVerification<T>(
  args: {
    tool: string;
    title: string;
    method: string;
    parameters?: Record<string, string | number>;
    notes?: string[];
    generatedAt?: Date;
  },
  results: T,
): VerificationEnvelope<T>;

/** Format an ISO-8601 timestamp (UTC, second precision) for every artefact. */
export declare function timestamp(date?: Date): string;

/** Suggested filename helper: `geodesia-terrain-profile-2026-11-15T00-04-40Z`. */
export declare function exportFilename(slug: string, ext: string, date?: Date): string;
