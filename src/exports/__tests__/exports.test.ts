/**
 * GEODESIA — EXPORT PIPELINE TESTS
 * ---------------------------------------------------------------------------
 * Runs in plain Node (vitest default environment). The PDF tests load the
 * generated document back with `PDFDocument.load` and then decode every page
 * content stream, so they assert *rendered geometry*, not just "did not throw":
 *   - every one of 40 table rows is present exactly once (no truncated rows)
 *   - the table header row is repeated on every page the table spans
 *   - every text run stays inside the 40 pt margins (no horizontal overflow)
 *   - no two text runs collide on the same baseline
 *   - a long paragraph is wrapped (long tokens are hard-broken, no 150+ char runs)
 *   - footer + `Page n of m` on every page
 */

import { describe, expect, it } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

import {
  buildCSVBlob,
  buildJSONBlob,
  buildPDF,
  buildVerification,
  downloadBlob,
  exportFilename,
  exportPDF,
  timestamp,
} from '../index';
import type { PdfReportSpec } from '../types';

/* ------------------------------------------------------------------------- */
/* helpers                                                                    */
/* ------------------------------------------------------------------------- */

interface TextRun {
  page: number;
  x: number;
  y: number;
  text: string;
  font: string;
  size: number;
  width: number;
}

/** Logical line reconstructed from (possibly per-character) runs sharing a
 *  baseline. Tracked micro-labels are drawn one glyph at a time, so raw runs
 *  cannot be compared to whole words. Runs separated by more than 3 pt become
 *  separate segments (table cells, label/value pairs). */
interface TextLine {
  page: number;
  y: number;
  text: string;
}

function mergeLines(runs: TextRun[]): TextLine[] {
  const groups = new Map<string, TextRun[]>();
  for (const run of runs) {
    const key = `${run.page}|${Math.round(run.y * 10) / 10}`;
    const list = groups.get(key) ?? [];
    list.push(run);
    groups.set(key, list);
  }

  const lines: TextLine[] = [];
  for (const [key, list] of groups) {
    const page = Number(key.split('|')[0]);
    list.sort((a, b) => a.x - b.x);
    let text = '';
    let endX = Number.NEGATIVE_INFINITY;
    for (const run of list) {
      if (text && run.x - endX > 3) {
        lines.push({ page, y: list[0]!.y, text });
        text = '';
      }
      text += run.text;
      endX = run.x + run.width;
    }
    if (text) lines.push({ page, y: list[0]!.y, text });
  }
  return lines;
}

async function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

async function blobText(blob: Blob): Promise<string> {
  return blob.text();
}

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;

/** Decoded (inflated) content streams of a page, as WinAnsi-ish strings. */
function pageStreamText(doc: PDFDocument, page: PDFPage): string {
  const contents = page.node.Contents();
  if (!contents || !(contents instanceof PDFArray)) return '';
  let stream = '';
  for (const ref of contents.asArray()) {
    const object = doc.context.lookup(ref);
    if (object instanceof PDFRawStream) {
      stream += Buffer.from(decodePDFRawStream(object).decode()).toString('latin1');
      stream += '\n';
    }
  }
  return stream;
}

/** Decode every text run on every page, with font/size/position/width. */
async function extractTextRuns(bytes: Uint8Array): Promise<TextRun[]> {
  const doc = await PDFDocument.load(bytes);
  const metricsDoc = await PDFDocument.create();
  const metrics: Record<string, PDFFont> = {
    Helvetica: await metricsDoc.embedFont(StandardFonts.Helvetica),
    'Helvetica-Bold': await metricsDoc.embedFont(StandardFonts.HelveticaBold),
    Courier: await metricsDoc.embedFont(StandardFonts.Courier),
    'Courier-Bold': await metricsDoc.embedFont(StandardFonts.CourierBold),
  };

  const runs: TextRun[] = [];

  doc.getPages().forEach((page, pageIndex) => {
    const stream = pageStreamText(doc, page);

    /* map font resource aliases to base standard font names */
    const aliases = new Map<string, string>();
    const resources = page.node.Resources();
    const fontDict = resources?.lookup(PDFName.of('Font'));
    if (fontDict instanceof PDFDict) {
      for (const [name] of fontDict.entries()) {
        const key = name.toString().replace(/^\//, '');
        aliases.set(key, key.replace(/-\d+$/, ''));
      }
    }

    const token =
      /\/([^\s/]+) ([\d.]+) Tf|(-?\d+(?:\.\d+)?) (-?\d+(?:\.\d+)?) Tm|<([0-9A-Fa-f]+)> Tj/g;
    let font = '';
    let size = 0;
    let x = 0;
    let y = 0;

    for (const match of stream.matchAll(token)) {
      if (match[1] !== undefined) {
        font = aliases.get(match[1]) ?? match[1];
        size = Number(match[2]);
      } else if (match[3] !== undefined) {
        x = Number(match[3]);
        y = Number(match[4]);
      } else if (match[5] !== undefined) {
        const text = Buffer.from(match[5], 'hex').toString('latin1');
        const metric = metrics[font];
        const width = metric ? metric.widthOfTextAtSize(text, size) : 0;
        runs.push({ page: pageIndex, x, y, text, font, size, width });
      }
    }
  });

  return runs;
}

async function pageContentStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((page) => pageStreamText(doc, page));
}

function runsWith(runs: TextRun[], text: string): TextRun[] {
  return runs.filter((run) => run.text === text);
}

/** A minimal but realistic report: 4 parameters, kv results, 40-row table,
 *  long text, notes. */
function buildReportSpec(): PdfReportSpec {
  const rows = Array.from({ length: 40 }, (_, index) => [
    `R-${String(index + 1).padStart(4, '0')}`,
    (1250.5 + index * 12.25).toFixed(2),
    (index * 0.75).toFixed(2),
    (index % 7).toFixed(1),
    String(180 + index),
    'WGS 84',
  ]);

  return {
    meta: {
      tool: 'Terrain Profile',
      title: 'Terrain Profile Report',
      subtitle: 'Geodesic transect, 40 sampled stations',
      generatedAt: new Date('2026-11-15T00:04:40Z'),
      parameters: [
        { label: 'Start', value: '1.2921 S, 36.8219 E' },
        { label: 'End', value: '1.3100 S, 36.8500 E' },
        { label: 'Datum', value: 'WGS 84' },
        { label: 'Method', value: 'Geodesic inverse (Karney)' },
      ],
      notes: ['Elevations sampled client-side.', 'All computation performed in the browser.'],
    },
    sections: [
      {
        kind: 'kv',
        heading: 'Results',
        rows: [
          { label: 'Distance', value: '4,215.62 m', emphasis: true },
          { label: 'Gain', value: '182.4 m' },
          { label: 'Descent', value: '96.1 m' },
        ],
      },
      {
        kind: 'table',
        heading: 'Sampled stations',
        columns: [
          { label: 'Station', align: 'left' },
          { label: 'Chainage', unit: 'm', align: 'right' },
          { label: 'Elevation', unit: 'm', align: 'right' },
          { label: 'Slope', unit: '%', align: 'right' },
          { label: 'Slope', unit: 'deg', align: 'right' },
          { label: 'Bearing', unit: 'deg', align: 'right' },
        ],
        rows,
        footnote: 'Levels reduced to the WGS 84 ellipsoid.',
      },
      {
        kind: 'text',
        heading: 'Method',
        paragraphs: [
          'This report is generated entirely in the browser. ' +
            'The transect between the two control points is solved with the inverse geodesic problem on the WGS 84 ellipsoid and sampled at a fixed interval. '.repeat(
              24,
            ) +
            'Long unbroken token follows: ' +
            'SUPERCALIFRAGILISTICEXPIALIDOCIOUS'.repeat(6) +
            '. End of paragraph with a unicode prime 1°23′45.6″S and a delta Δs.',
        ],
      },
      {
        kind: 'notes',
        heading: 'Notes',
        lines: ['Coordinates are WGS 84 geographic.', 'Elevation source: client-side sample.'],
      },
    ],
  };
}

/* ------------------------------------------------------------------------- */
/* CSV                                                                        */
/* ------------------------------------------------------------------------- */

describe('buildCSVBlob', () => {
  it('starts with a UTF-8 BOM and prefixes header lines with #', async () => {
    const blob = buildCSVBlob(
      [{ key: 'a', label: 'Alpha' }],
      [{ a: 1 }],
      ['geodesia.online — Terrain Profile', 'generated: 2026-11-15T00:04:40Z'],
    );
    expect(blob.type).toContain('text/csv');
    const bytesBytes = await blobBytes(blob);
    expect([...bytesBytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    /* Blob.text() strips a leading BOM during UTF-8 decode, so keep the BOM
     * assertion on the raw bytes above and assert the decoded payload here. */
    const text = await blobText(blob);
    expect(text.startsWith('# geodesia.online')).toBe(true);
    expect(text).toContain('# generated: 2026-11-15T00:04:40Z');
    expect(text).toContain('\r\n');
  });

  it('folds units into the header label and keeps column order', async () => {
    const text = await blobText(
      buildCSVBlob(
        [
          { key: 'e', label: 'Elevation', unit: 'm' },
          { key: 'd', label: 'Distance' },
        ],
        [{ d: 10, e: 2.5 }],
      ),
    );
    expect(text).toContain('Elevation (m),Distance');
  });

  it('applies RFC 4180 quoting, doubled quotes and blanks for null', async () => {
    const text = await blobText(
      buildCSVBlob(
        [{ key: 'v', label: 'Value' }],
        [
          { v: 'a,b' },
          { v: 'say "hi"' },
          { v: 'line\nbreak' },
          { v: null },
          { v: undefined },
          { v: 42 },
        ],
      ),
    );
    const lines = text.split('\r\n');
    expect(lines).toContain('"a,b"');
    expect(lines).toContain('"say ""hi"""');
    expect(lines).toContain('"line\nbreak"');
    expect(lines).toContain('42');
    expect(lines.filter((line) => line === '').length).toBeGreaterThan(0);
  });

  it('is a no-op download outside the browser', () => {
    expect(() => downloadBlob('x.csv', new Blob(['a']))).not.toThrow();
  });
});

/* ------------------------------------------------------------------------- */
/* JSON + envelope                                                            */
/* ------------------------------------------------------------------------- */

describe('JSON verification artefacts', () => {
  it('format timestamps as ISO-8601 UTC at second precision', () => {
    expect(timestamp(new Date('2026-11-15T00:04:40.123Z'))).toBe('2026-11-15T00:04:40Z');
    expect(timestamp()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });

  it('produce filesystem-safe export filenames', () => {
    const date = new Date('2026-11-15T00:04:40Z');
    expect(exportFilename('Terrain Profile', 'CSV', date)).toBe(
      'geodesia-terrain-profile-2026-11-15T00-04-40Z.csv',
    );
    expect(exportFilename('Polygon / Area', 'json', date)).toBe(
      'geodesia-polygon-area-2026-11-15T00-04-40Z.json',
    );
  });

  it('serialise JSON with 2-space indent and stable schema key order', async () => {
    const envelope = buildVerification(
      {
        tool: 'Terrain Profile',
        title: 'Terrain report',
        method: 'geodesic inverse',
        parameters: { datum: 'WGS 84', samples: 40 },
        notes: ['client-side'],
        generatedAt: new Date('2026-11-15T00:04:40Z'),
      },
      { distance: 4215.62 },
    );
    expect(Object.keys(envelope)).toEqual([
      'schema',
      'tool',
      'title',
      'generatedAt',
      'engine',
      'parameters',
      'results',
      'notes',
    ]);
    expect(envelope.schema).toBe('geodesia.report/v1');
    expect(envelope.engine).toEqual({
      name: 'Geodesia',
      url: 'https://geodesia.online',
      datum: 'WGS 84',
      ellipsoid: 'WGS 84 (a = 6378137 m, 1/f = 298.257223563)',
      method: 'geodesic inverse',
    });
    expect(envelope.generatedAt).toBe('2026-11-15T00:04:40Z');

    const blob = buildJSONBlob(envelope);
    expect(blob.type).toContain('application/json');
    const text = await blobText(blob);
    expect(text.startsWith('{\n  "schema": "geodesia.report/v1",')).toBe(true);
    expect(JSON.parse(text)).toEqual(envelope);
  });
});

/* ------------------------------------------------------------------------- */
/* PDF                                                                        */
/* ------------------------------------------------------------------------- */

describe('buildPDF / exportPDF', () => {
  it('renders a loadable A4 report with metadata, mark and footers', async () => {
    const bytes = await buildPDF(buildReportSpec());
    expect(bytes.byteLength).toBeGreaterThan(5000);

    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toBe('Terrain Profile Report');
    expect(doc.getAuthor()).toBe('Geodesia');
    for (const page of doc.getPages()) {
      expect(page.getWidth()).toBeCloseTo(PAGE_WIDTH, 1);
      expect(page.getHeight()).toBeCloseTo(PAGE_HEIGHT, 1);
    }

    const streams = await pageContentStreams(bytes);
    /* vector brand mark: basalt tile fill + signal station dot on page 1 */
    expect(streams[0]).toContain('0.054901960784313725 0.0784313725490196 0.07450980392156863 rg');
    expect(streams[0]).toContain('0.7529411764705882 0.27058823529411763 0.11764705882352941 rg');
    /* triangle path present in the mark (SVG grid coordinates) */
    expect(streams[0]).toContain('24 11 m');
    /* chart is absent when not supplied: no image XObject is painted */
    expect(streams[0]).not.toMatch(/\/[A-Za-z0-9]+\s+Do\b/);

    const lines = mergeLines(await extractTextRuns(bytes));
    expect(lines.some((line) => line.text === 'GEODESIA')).toBe(true);
  });

  it('paginates a 40-row table with a repeated header row and no lost rows', async () => {
    const bytes = await buildPDF(buildReportSpec());
    const runs = await extractTextRuns(bytes);

    /* every sentinel row exactly once */
    for (let index = 1; index <= 40; index += 1) {
      const sentinel = `R-${String(index).padStart(4, '0')}`;
      const occurrences = runsWith(runs, sentinel);
      expect(occurrences.length, `row ${sentinel} rendered exactly once`).toBe(1);
    }

    /* the table spans >= 2 pages and each such page repeats the header row */
    const rowPages = new Set(
      runs.filter((run) => /^R-\d{4}$/.test(run.text)).map((run) => run.page),
    );
    expect(rowPages.size).toBeGreaterThanOrEqual(2);
    const headerLines = mergeLines(runs).filter((line) => line.text === 'STATION');
    for (const page of rowPages) {
      const headerOnPage = headerLines.some((line) => line.page === page);
      expect(headerOnPage, `table header repeats on page ${page + 1}`).toBe(true);
    }
  });

  it('wraps long text, keeps runs inside the margins and avoids collisions', async () => {
    const bytes = await buildPDF(buildReportSpec());
    const runs = await extractTextRuns(bytes);
    expect(runs.length).toBeGreaterThan(100);

    /* no run overflows the right margin (right-aligned text ends at it) */
    const overflow = runs.filter((run) => run.x + run.width > CONTENT_RIGHT + 0.75);
    expect(overflow.map((run) => `${run.text}@${run.page}:${run.x + run.width}`)).toEqual([]);

    /* nothing above the masthead / below the footer band */
    for (const run of runs) {
      expect(run.y, `baseline for "${run.text}"`).toBeGreaterThan(25);
      expect(run.y).toBeLessThan(PAGE_HEIGHT - 20);
      expect(run.x).toBeGreaterThan(30);
    }

    /* no 150+ character run: the long token was hard-broken */
    const longest = Math.max(...runs.map((run) => run.text.length));
    expect(longest).toBeLessThan(150);
    const longTokenChunks = runs.filter((run) => run.text.includes('SUPERCALIFRAGILISTIC'));
    expect(longTokenChunks.length).toBeGreaterThan(1);

    /* no two runs share a baseline with overlapping x-ranges */
    const byPage = new Map<number, TextRun[]>();
    for (const run of runs) {
      const list = byPage.get(run.page) ?? [];
      list.push(run);
      byPage.set(run.page, list);
    }
    for (const pageRuns of byPage.values()) {
      for (let i = 0; i < pageRuns.length; i += 1) {
        for (let j = i + 1; j < pageRuns.length; j += 1) {
          const a = pageRuns[i]!;
          const b = pageRuns[j]!;
          if (Math.abs(a.y - b.y) >= 1) continue;
          const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          expect(
            overlap,
            `baseline collision "${a.text}" vs "${b.text}" on page ${a.page + 1}`,
          ).toBeLessThan(1.5);
        }
      }
    }
  });

  it('prints the attribution footer and page numbers on every page', async () => {
    const bytes = await buildPDF(buildReportSpec());
    const runs = await extractTextRuns(bytes);
    const doc = await PDFDocument.load(bytes);
    const total = doc.getPageCount();
    for (let page = 0; page < total; page += 1) {
      const pageRuns = runs.filter((run) => run.page === page);
      expect(
        pageRuns.some((run) => run.text === 'geodesia.online · client-side computation · WGS 84'),
      ).toBe(true);
      expect(pageRuns.some((run) => run.text === `Page ${page + 1} of ${total}`)).toBe(true);
    }
  });

  it('never throws for an unusable chart image and skips it silently', async () => {
    const spec = buildReportSpec();
    spec.chartSvg = 'data:image/svg+xml;base64,not-a-real-image';
    const bytes = await buildPDF(spec);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    const streams = await pageContentStreams(bytes);
    /* rasterisation is impossible without a DOM: the figure is skipped, never fatal */
    for (const stream of streams) expect(stream).not.toMatch(/\/[A-Za-z0-9]+\s+Do\b/);
  });

  it('sanitises unencodable glyphs instead of throwing', async () => {
    const spec = buildReportSpec();
    spec.meta.title = 'Terrain 地形 profile — 1°23′45.6″S Δs';
    const bytes = await buildPDF(spec);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
  });

  it('exportPDF is a safe no-op outside the browser', async () => {
    await expect(exportPDF(buildReportSpec())).resolves.toBeUndefined();
  });
});

/* ------------------------------------------------------------------------- */
/* polygon v2 — three surfaces (grid / geodesic / ground) + leg table         */
/* ------------------------------------------------------------------------- */

const LEG_ROWS = Array.from({ length: 40 }, (_, index) => [
  `L-${String(index + 1).padStart(4, '0')}`,
  String(index + 1),
  String(((index + 1) % 40) + 1),
  (82.41 + index * 0.37).toFixed(3),
  (82.36 + index * 0.37).toFixed(3),
  (82.34 + index * 0.37).toFixed(3),
  (12.5 + index * 9.1).toFixed(2),
]);

function buildPolygonReportSpec(): PdfReportSpec {
  return {
    meta: {
      tool: 'Polygon Area',
      title: 'Polygon Area & Coordinate Report',
      subtitle: 'Reference system: UTM · Zone 37S · surface comparison',
      generatedAt: new Date('2026-11-15T00:04:40Z'),
      parameters: [
        { label: 'Reference system', value: 'UTM (WGS 84)' },
        { label: 'Zone / hemisphere', value: '37 / S' },
        { label: 'Mean elevation', value: '1 650.0 m' },
        { label: 'Combined scale factor', value: '1.00006760' },
        { label: 'Vertices', value: '40' },
      ],
      notes: [
        'Grid area is planar on the UTM projection; geodesic area is on the WGS 84 ellipsoid.',
        'Ground area divides the grid area by CSF² using the mean elevation shown above.',
      ],
    },
    sections: [
      {
        kind: 'kv',
        heading: 'Grid surface',
        rows: [
          { label: 'Area', value: '249,360.01 m²', emphasis: true },
          { label: 'Area (hectares)', value: '24.9360 ha' },
          { label: 'Perimeter', value: '1,997.449 m' },
        ],
      },
      {
        kind: 'kv',
        heading: 'Geodesic surface',
        rows: [
          { label: 'Area', value: '249,197.01 m²', emphasis: true },
          { label: 'Perimeter', value: '1,996.796 m' },
          { label: 'Method', value: 'Karney ellipsoidal area' },
        ],
      },
      {
        kind: 'kv',
        heading: 'Ground surface (CSF)',
        rows: [
          { label: 'Area', value: '249,326.30 m²', emphasis: true },
          { label: 'Perimeter', value: '1,997.314 m' },
          { label: 'CSF', value: '1.00006760' },
          { label: 'Projection k', value: '1.00032631' },
          { label: 'Elevation factor', value: '0.99974137' },
        ],
      },
      {
        kind: 'table',
        heading: 'Boundary legs',
        columns: [
          { label: 'Leg', align: 'left' },
          { label: 'From', align: 'right' },
          { label: 'To', align: 'right' },
          { label: 'Grid distance', unit: 'm', align: 'right' },
          { label: 'Geodesic', unit: 'm', align: 'right' },
          { label: 'Ground', unit: 'm', align: 'right' },
          { label: 'Grid bearing', unit: 'deg', align: 'right' },
        ],
        rows: LEG_ROWS,
        footnote: 'Closure leg runs from the last vertex to the first; bearings are clockwise from grid north.',
      },
      {
        kind: 'text',
        heading: 'Surface comparison',
        paragraphs: [
          'The three surfaces answer different questions and legitimately differ: the grid figure carries the UTM projection scale, the geodesic figure is on the WGS 84 ellipsoid, and the ground figure divides the grid figure by CSF² at the mean elevation. Quote the surface that matches how the boundary is defined.',
        ],
      },
      {
        kind: 'notes',
        heading: 'Notes',
        lines: ['One UTM zone must span the whole ring.', 'Self-intersection is flagged, never repaired.'],
      },
    ],
  };
}

describe('polygon v2 exports — grid / geodesic / ground', () => {
  it('paginates a three-surface report with a 40-row leg table', async () => {
    const bytes = await buildPDF(buildPolygonReportSpec());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toBe('Polygon Area & Coordinate Report');

    const streams = await pageContentStreams(bytes);
    for (const stream of streams) expect(stream).not.toMatch(/\/[A-Za-z0-9]+\s+Do\b/);

    const runs = await extractTextRuns(bytes);
    const lines = mergeLines(runs);

    /* all three surface sections are rendered as tracked headings (tracked
     * labels are drawn glyph-by-glyph; spaces are gaps, so assert the words) */
    const lineTexts = lines.map((line) => line.text);
    for (const word of ['GRID', 'GEODESIC', 'GROUND']) {
      expect(lineTexts, word).toContain(word);
    }
    expect(lineTexts.filter((text) => text === 'SURFACE').length).toBeGreaterThanOrEqual(3);
    expect(lineTexts).toContain('(CSF)');
    expect(lineTexts).toContain('COMPARISON');
    /* ExportMeta.notes are printed at the end (labelled "Report notes" when a
     * notes section already exists) */
    expect(lineTexts).toContain('REPORT');
    expect(lineTexts).toContain('NOTES');

    /* every leg row appears exactly once — no truncated rows */
    for (let index = 1; index <= 40; index += 1) {
      const sentinel = `L-${String(index).padStart(4, '0')}`;
      expect(runsWith(runs, sentinel).length, sentinel).toBe(1);
    }

    /* footer + page numbers on every page */
    for (let page = 0; page < doc.getPageCount(); page += 1) {
      const pageRuns = runs.filter((run) => run.page === page);
      expect(pageRuns.some((run) => run.text === 'geodesia.online · client-side computation · WGS 84')).toBe(true);
      expect(pageRuns.some((run) => run.text === `Page ${page + 1} of ${doc.getPageCount()}`)).toBe(true);
    }

    /* margins + no baseline collisions (same guarantees as the terrain report) */
    const CONTENT_RIGHT_EDGE = PAGE_WIDTH - MARGIN;
    expect(runs.filter((run) => run.x + run.width > CONTENT_RIGHT_EDGE + 0.75)).toEqual([]);
    for (const run of runs) {
      expect(run.y).toBeGreaterThan(25);
      expect(run.y).toBeLessThan(PAGE_HEIGHT - 20);
    }
    const byPage = new Map<number, TextRun[]>();
    for (const run of runs) {
      const list = byPage.get(run.page) ?? [];
      list.push(run);
      byPage.set(run.page, list);
    }
    for (const pageRuns of byPage.values()) {
      for (let i = 0; i < pageRuns.length; i += 1) {
        for (let j = i + 1; j < pageRuns.length; j += 1) {
          const a = pageRuns[i]!;
          const b = pageRuns[j]!;
          if (Math.abs(a.y - b.y) >= 1) continue;
          const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
          expect(overlap, `baseline collision "${a.text}" vs "${b.text}"`).toBeLessThan(1.5);
        }
      }
    }
  });

  it('exports the three surfaces as a verification JSON document', async () => {
    const envelope = buildVerification(
      {
        tool: 'Polygon Area',
        title: 'Polygon Area & Coordinate Report',
        method: 'Gaussian shoelace (grid) + Karney ellipsoidal area (geodesic) + CSF² reduction (ground)',
        parameters: { referenceSystem: 'utm', zone: 37, hemisphere: 'S', meanElevationM: 1650, vertices: 40 },
        notes: ['CSF = k · EF'],
        generatedAt: new Date('2026-11-15T00:04:40Z'),
      },
      {
        grid: { area: 249360.006947, perimeter: 1997.448804 },
        geodesic: { area: 249197.01234, perimeter: 1996.795878 },
        ground: { area: 249326.296595, perimeter: 1997.313784 },
        csf: 1.0000676005953588,
      },
    );
    expect(Object.keys(envelope)).toEqual([
      'schema',
      'tool',
      'title',
      'generatedAt',
      'engine',
      'parameters',
      'results',
      'notes',
    ]);
    const parsed = JSON.parse(await blobText(buildJSONBlob(envelope))) as typeof envelope;
    expect(parsed.schema).toBe('geodesia.report/v1');
    expect(parsed.results.grid.area).toBeCloseTo(249360.006947, 6);
    expect(parsed.results.geodesic.area).toBeCloseTo(249197.01234, 6);
    expect(parsed.results.ground.area).toBeCloseTo(249326.296595, 6);
    expect(parsed.parameters.zone).toBe(37);
  });

  it('exports a self-describing CSV with all 40 legs', async () => {
    const blob = buildCSVBlob(
      [
        { key: 'leg', label: 'Leg' },
        { key: 'grid', label: 'Grid distance', unit: 'm' },
        { key: 'geodesic', label: 'Geodesic distance', unit: 'm' },
        { key: 'ground', label: 'Ground distance', unit: 'm' },
        { key: 'bearing', label: 'Grid bearing', unit: 'deg' },
      ],
      LEG_ROWS.map((row) => ({ leg: row[0], grid: row[3], geodesic: row[4], ground: row[5], bearing: row[6] })),
      ['geodesia.online — Polygon Area', 'reference system: UTM zone 37S', 'surfaces: grid, geodesic, ground (CSF)'],
    );
    const bytes = await blobBytes(blob);
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const text = await blobText(blob);
    expect(text).toContain('# geodesia.online');
    expect(text).toContain('# reference system: UTM zone 37S');
    expect(text).toContain('Grid distance (m),Geodesic distance (m),Ground distance (m)');
    for (let index = 1; index <= 40; index += 1) {
      expect(text).toContain(`L-${String(index).padStart(4, '0')}`);
    }
  });
});
