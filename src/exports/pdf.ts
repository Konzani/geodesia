/**
 * GEODESIA — PDF FIELD REPORT (pdf-lib, A4 portrait, 40 pt margins)
 * ===========================================================================
 * A deliberate "surveyor's field report sheet", not a dashboard:
 *   - brand mark redrawn with vector primitives (tile + graticule + trigon +
 *     station dot), geometry taken from `public/brand/geodesia-mark.svg`
 *   - uppercase tracked micro-labels, mono (Courier) figures, hairline rules
 *   - full masthead on page 1, compact running header on continuation pages
 *   - footer on every page: `geodesia.online · client-side computation · WGS 84`
 *     plus `Page n of m`
 *
 * BUNDLE DISCIPLINE
 *   `pdf-lib` is imported with a dynamic `import()` inside `buildPDF` only.
 *   This module has **no runtime imports at module scope** (types are erased),
 *   so importing `buildPDF` costs a few kB of layout code, not the ~1 MB
 *   pdf-lib payload. It also keeps this file executable in Node for tests.
 *
 * ENCODING
 *   Standard-14 Helvetica/Courier use WinAnsi; every string passes through
 *   `sanitizeText`, which folds common Unicode (′, ″, —, Δ, →) and replaces
 *   anything unencodable. A stray glyph can therefore never throw mid-report.
 */

import type { ExportMeta, PdfReportSpec, PdfSection } from './types';
import type { PDFDocument, PDFFont, PDFImage, PDFPage } from 'pdf-lib';

type PdfModule = typeof import('pdf-lib');
type PdfColor = ReturnType<PdfModule['rgb']>;

/* ------------------------------------------------------------------------- */
/* geometry + palette                                                         */
/* ------------------------------------------------------------------------- */

const PAGE_WIDTH = 595.28;
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;

const CONTENT_LEFT = MARGIN;
const CONTENT_RIGHT = PAGE_WIDTH - MARGIN;
const CONTENT_WIDTH = CONTENT_RIGHT - CONTENT_LEFT;

/** Lowest baseline the body may reach; below it live rule + footer. */
const BODY_BOTTOM = 62;
const FOOTER_RULE_Y = 46;
const FOOTER_BASELINE = 31;
const FOOTER_TEXT = 'geodesia.online · client-side computation · WGS 84';

/** Brand palette — numeric copies of `src/ui/styles/tokens.css` values
 *  (CSS custom properties are not reachable from the PDF renderer). */
const PALETTE = {
  paper: [246, 243, 236], // #F6F3EC survey paper
  ink: [14, 20, 19], // #0E1413 basalt ink
  inkStrong: [11, 15, 14], // #0B0F0E
  inkSoft: [53, 68, 63], // #35443F
  inkMuted: [75, 92, 85], // #4B5C55
  line: [214, 208, 190], // #D6D0BE
  lineSoft: [229, 224, 210], // #E5E0D2
  signal: [192, 69, 30], // #C0451E signal vermilion
} as const;

type PaletteKey = keyof typeof PALETTE;
type Colors = Record<PaletteKey, PdfColor>;

interface Fonts {
  sans: PDFFont;
  sansBold: PDFFont;
  mono: PDFFont;
  monoBold: PDFFont;
}

interface Report {
  pdf: PdfModule;
  doc: PDFDocument;
  fonts: Fonts;
  colors: Colors;
  pages: PDFPage[];
  page: PDFPage;
  /** Top of the next content block (PDF user space, y up). */
  y: number;
  meta: ExportMeta;
  title: string;
  subtitle: string;
  tool: string;
  stamp: string;
}

/* ------------------------------------------------------------------------- */
/* text hygiene (WinAnsi)                                                     */
/* ------------------------------------------------------------------------- */

const UNICODE_FALLBACKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[\u2018\u2019\u02BC\u2032]/g, "'"],
  [/[\u201C\u201D\u2033]/g, '"'],
  [/[\u2013\u2014\u2212]/g, '-'],
  [/\u0394/g, 'd'],
  [/\u00A0/g, ' '],
  [/\u2026/g, '...'],
  [/\u2192/g, '->'],
  [/\u2190/g, '<-'],
  [/\u2248/g, '~'],
  [/\u2264/g, '<='],
  [/\u2265/g, '>='],
  [/\u00B2/g, '2'],
  [/\u00B3/g, '3'],
  [/\u00B5/g, 'u'],
];

/**
 * Make any value encodable by the Standard-14 fonts.
 * Standard fonts use WinAnsi; Greek/CJK/emoji cannot be encoded and would
 * throw. Single-line mode collapses whitespace; block mode keeps newlines.
 */
function sanitizeText(value: unknown, multiline = false): string {
  let text = String(value ?? '');
  for (const [pattern, replacement] of UNICODE_FALLBACKS) {
    text = text.replace(pattern, replacement);
  }
  // Keep printable ASCII + Latin-1 supplement; everything else becomes '?'.
  text = text.replace(/[^\x20-\x7E\xA0-\xFF\n]/g, '?');
  if (!multiline) return text.replace(/\s+/g, ' ').trim();
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n');
}

/* ------------------------------------------------------------------------- */
/* measuring + drawing primitives                                             */
/* ------------------------------------------------------------------------- */

interface TextOptions {
  font: PDFFont;
  size: number;
  color: PdfColor;
  /** Extra advance per glyph in pt (uppercase micro-label tracking). */
  tracking?: number;
}

function trackedWidth(
  _ctx: Report,
  text: string,
  font: PDFFont,
  size: number,
  tracking: number,
): number {
  const safe = sanitizeText(text);
  if (!safe) return 0;
  if (!tracking) return font.widthOfTextAtSize(safe, size);
  let width = 0;
  for (const char of safe) width += font.widthOfTextAtSize(char, size) + tracking;
  return Math.max(0, width - tracking);
}

/** Draw a single sanitized line; returns the advance width. */
function drawText(ctx: Report, value: unknown, x: number, y: number, options: TextOptions): number {
  const safe = sanitizeText(value);
  if (!safe) return 0;
  const tracking = options.tracking ?? 0;
  const advance = options.font.widthOfTextAtSize(safe, options.size);
  if (!tracking) {
    ctx.page.drawText(safe, {
      x,
      y,
      size: options.size,
      font: options.font,
      color: options.color,
    });
    return advance;
  }
  let cursor = x;
  for (const char of safe) {
    if (char !== ' ') {
      ctx.page.drawText(char, {
        x: cursor,
        y,
        size: options.size,
        font: options.font,
        color: options.color,
      });
    }
    cursor += options.font.widthOfTextAtSize(char, options.size) + tracking;
  }
  return Math.max(0, cursor - tracking - x);
}

/** Draw a single sanitized line right-aligned to `rightX`. */
function drawTextRight(
  ctx: Report,
  value: unknown,
  rightX: number,
  y: number,
  options: TextOptions,
): void {
  const width = trackedWidth(
    ctx,
    value as string,
    options.font,
    options.size,
    options.tracking ?? 0,
  );
  drawText(ctx, value, rightX - width, y, options);
}

/** Truncate to a pixel width with an ASCII ellipsis. */
function truncateToWidth(
  _ctx: Report,
  value: unknown,
  font: PDFFont,
  size: number,
  maxWidth: number,
  tracking = 0,
): string {
  const text = sanitizeText(value);
  const widthOf = (candidate: string): number =>
    tracking
      ? trackedWidth(_ctx, candidate, font, size, tracking)
      : font.widthOfTextAtSize(candidate, size);
  if (widthOf(text) <= maxWidth) return text;
  const suffix = '...';
  const available = maxWidth - widthOf(suffix);
  if (available <= 0) return suffix;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (widthOf(text.slice(0, mid)) <= available) lo = mid;
    else hi = mid - 1;
  }
  const kept = text.slice(0, lo).trimEnd();
  return `${kept}${suffix}`;
}

/** Greedy word wrap; hard-breaks a single word that cannot fit. */
function wrapText(
  _ctx: Report,
  value: unknown,
  font: PDFFont,
  size: number,
  maxWidth: number,
): string[] {
  const source = sanitizeText(value, true);
  if (!source) return [];
  const lines: string[] = [];

  for (const paragraph of source.split('\n')) {
    const words = paragraph.split(' ').filter(Boolean);
    if (words.length === 0) continue;
    let line = '';
    for (const word of words) {
      const wordWidth = font.widthOfTextAtSize(word, size);
      if (wordWidth > maxWidth) {
        if (line) {
          lines.push(line);
          line = '';
        }
        let chunk = '';
        for (const char of word) {
          if (!chunk) {
            chunk = char;
            continue;
          }
          if (font.widthOfTextAtSize(chunk + char, size) <= maxWidth) chunk += char;
          else {
            lines.push(chunk);
            chunk = char;
          }
        }
        line = chunk;
        continue;
      }
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function hairline(
  ctx: Report,
  y: number,
  x1: number,
  x2: number,
  thickness: number,
  color: PdfColor,
  opacity = 1,
): void {
  if (x2 <= x1) return;
  ctx.page.drawLine({
    start: { x: x1, y },
    end: { x: x2, y },
    thickness,
    color,
    opacity,
  });
}

/* ------------------------------------------------------------------------- */
/* brand mark — redrawn from public/brand/geodesia-mark.svg, 48-unit grid      */
/* ------------------------------------------------------------------------- */

const MARK_GRID = 48;
const MARK_TILE_PATH =
  'M 10 0 H 38 Q 48 0 48 10 V 38 Q 48 48 38 48 H 10 Q 0 48 0 38 V 10 Q 0 0 10 0 Z';
const MARK_TRIGON_PATH = 'M 24 11 L 36.5 36 L 11.5 36 Z';

/**
 * Tile + graticule + trigon + station dot. `top` is the tile's top edge.
 * Paths are drawn in SVG coordinates (y down) via `drawSvgPath`, which flips
 * the axis internally; the graticule/dot are placed with the same grid mapping.
 */
function drawBrandMark(ctx: Report, x: number, top: number, size: number): void {
  const scale = size / MARK_GRID;
  const gridX = (gx: number): number => x + gx * scale;
  const gridY = (gy: number): number => top - gy * scale;

  /* basalt tile */
  ctx.page.drawSvgPath(MARK_TILE_PATH, {
    x,
    y: top,
    scale,
    color: ctx.colors.ink,
  });

  /* hairlines graticule at ~12% paper */
  const graticule = ctx.colors.paper;
  for (const gy of [9, 39]) {
    ctx.page.drawLine({
      start: { x: gridX(16), y: gridY(gy) },
      end: { x: gridX(32), y: gridY(gy) },
      thickness: Math.max(0.35, 0.8 * scale),
      color: graticule,
      opacity: 0.12,
    });
  }
  for (const gx of [9, 39]) {
    ctx.page.drawLine({
      start: { x: gridX(gx), y: gridY(16) },
      end: { x: gridX(gx), y: gridY(32) },
      thickness: Math.max(0.35, 0.8 * scale),
      color: graticule,
      opacity: 0.12,
    });
  }

  /* trigon, stroked (stroke width scales with the SVG path transform) */
  ctx.page.drawSvgPath(MARK_TRIGON_PATH, {
    x,
    y: top,
    scale,
    borderColor: ctx.colors.paper,
    borderWidth: 3,
  });

  /* station dot, the single signal accent */
  ctx.page.drawCircle({
    x: gridX(24),
    y: gridY(28.2),
    size: 3.6 * scale,
    color: ctx.colors.signal,
  });
}

/* ------------------------------------------------------------------------- */
/* page scaffold                                                              */
/* ------------------------------------------------------------------------- */

function paperGround(ctx: Report): void {
  ctx.page.drawRectangle({
    x: 0,
    y: 0,
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
    color: ctx.colors.paper,
  });
}

function drawMasthead(ctx: Report): void {
  const top = PAGE_HEIGHT - MARGIN;

  drawBrandMark(ctx, CONTENT_LEFT, top, 34);

  const wordX = CONTENT_LEFT + 34 + 12;
  drawText(ctx, 'GEODESIA', wordX, top - 17.5, {
    font: ctx.fonts.sansBold,
    size: 19,
    color: ctx.colors.ink,
    tracking: 1.6,
  });
  drawText(ctx, 'LAND-SURVEY INSTRUMENTS', wordX, top - 31, {
    font: ctx.fonts.sans,
    size: 6.2,
    color: ctx.colors.inkMuted,
    tracking: 1.1,
  });

  const rightMax = CONTENT_WIDTH * 0.64;
  const tool = truncateToWidth(ctx, ctx.tool.toUpperCase(), ctx.fonts.sans, 7, rightMax, 1.2);
  drawTextRight(ctx, tool, CONTENT_RIGHT, top - 6, {
    font: ctx.fonts.sans,
    size: 7,
    color: ctx.colors.inkMuted,
    tracking: 1.2,
  });

  const title = truncateToWidth(ctx, ctx.title, ctx.fonts.sansBold, 13, rightMax);
  drawTextRight(ctx, title, CONTENT_RIGHT, top - 21, {
    font: ctx.fonts.sansBold,
    size: 13,
    color: ctx.colors.ink,
  });

  if (ctx.subtitle) {
    const subtitle = truncateToWidth(ctx, ctx.subtitle, ctx.fonts.sans, 8.5, rightMax);
    drawTextRight(ctx, subtitle, CONTENT_RIGHT, top - 34, {
      font: ctx.fonts.sans,
      size: 8.5,
      color: ctx.colors.inkSoft,
    });
  }

  drawTextRight(ctx, ctx.stamp, CONTENT_RIGHT, top - 47, {
    font: ctx.fonts.mono,
    size: 7.5,
    color: ctx.colors.inkMuted,
  });

  /* masthead rule: hairline with a short vermilion datum tick */
  const ruleY = top - 60;
  hairline(ctx, ruleY, CONTENT_LEFT, CONTENT_RIGHT, 0.6, ctx.colors.line);
  hairline(ctx, ruleY, CONTENT_LEFT, CONTENT_LEFT + 30, 1, ctx.colors.signal);

  ctx.y = ruleY - 22;
}

function drawRunningHeader(ctx: Report): void {
  const top = PAGE_HEIGHT - MARGIN;
  drawText(ctx, 'GEODESIA', CONTENT_LEFT, top - 3, {
    font: ctx.fonts.sansBold,
    size: 8.5,
    color: ctx.colors.ink,
    tracking: 1.2,
  });
  const running = truncateToWidth(
    ctx,
    `${ctx.tool} / ${ctx.title}`,
    ctx.fonts.sans,
    7.5,
    CONTENT_WIDTH * 0.7,
  );
  drawTextRight(ctx, running, CONTENT_RIGHT, top - 3, {
    font: ctx.fonts.sans,
    size: 7.5,
    color: ctx.colors.inkMuted,
  });
  const ruleY = top - 12;
  hairline(ctx, ruleY, CONTENT_LEFT, CONTENT_RIGHT, 0.5, ctx.colors.line);
  ctx.y = ruleY - 18;
}

function addPage(ctx: Report, first: boolean): void {
  const page = ctx.doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  ctx.pages.push(page);
  ctx.page = page;
  paperGround(ctx);
  if (first) drawMasthead(ctx);
  else drawRunningHeader(ctx);
}

/** Ensure `height` pt fit; start a new (running-header) page when they do not. */
function ensureSpace(ctx: Report, height: number): boolean {
  if (ctx.y - height >= BODY_BOTTOM) return false;
  addPage(ctx, false);
  return true;
}

/* ------------------------------------------------------------------------- */
/* section headings + shared section chrome                                   */
/* ------------------------------------------------------------------------- */

function drawSectionHeading(
  ctx: Report,
  heading: string,
  options: { gap?: number; continued?: boolean } = {},
): void {
  const gap = options.gap ?? 16;
  ctx.y -= gap;
  /* reserve heading + enough room for at least one row/line to follow */
  ensureSpace(ctx, 64);
  const label = `${sanitizeText(heading).toUpperCase()}${options.continued ? ' (CONTINUED)' : ''}`;
  drawText(ctx, label, CONTENT_LEFT, ctx.y - 8, {
    font: ctx.fonts.sansBold,
    size: 8,
    color: ctx.colors.ink,
    tracking: 1.15,
  });
  const ruleY = ctx.y - 13;
  hairline(ctx, ruleY, CONTENT_LEFT, CONTENT_RIGHT, 0.5, ctx.colors.line);
  ctx.y = ruleY - 15;
}

/* ------------------------------------------------------------------------- */
/* generic formatting                                                         */
/* ------------------------------------------------------------------------- */

/** Deterministic en-US grouping so PDFs read the same on every machine. */
function formatNumberCell(value: number): string {
  if (!Number.isFinite(value)) return '';
  if (Number.isInteger(value)) return value.toLocaleString('en-US');
  return value.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 3,
  });
}

function cellText(value: string | number): string {
  return typeof value === 'number' ? formatNumberCell(value) : sanitizeText(value);
}

/* ------------------------------------------------------------------------- */
/* sections                                                                   */
/* ------------------------------------------------------------------------- */

type KvSection = Extract<PdfSection, { kind: 'kv' }>;
type TableSection = Extract<PdfSection, { kind: 'table' }>;
type TextSection = Extract<PdfSection, { kind: 'text' }>;
type NotesSection = Extract<PdfSection, { kind: 'notes' }>;

function drawKvSection(ctx: Report, section: KvSection): void {
  drawSectionHeading(ctx, section.heading);
  if (section.rows.length === 0) {
    ctx.y -= 4;
    return;
  }

  const labelFontSize = 7.2;
  const labelTracking = 0.9;
  const valueFontSize = 9;

  for (const row of section.rows) {
    const label = sanitizeText(row.label).toUpperCase();
    const labelWidth = trackedWidth(
      ctx,
      label,
      ctx.fonts.sans,
      labelFontSize,
      labelTracking,
    );
    const value = cellText(row.value);
    const maxValueWidth = Math.max(80, CONTENT_WIDTH - labelWidth - 16);
    const valueFont = row.emphasis ? ctx.fonts.monoBold : ctx.fonts.mono;
    const valueSize = row.emphasis ? 9.5 : valueFontSize;
    const valueLines = wrapText(ctx, value, valueFont, valueSize, maxValueWidth);
    const rowHeight = Math.max(15.2, 11 + valueLines.length * 11.8);

    if (ensureSpace(ctx, rowHeight)) {
      /* continue the block on the new page with a repeated heading */
      drawSectionHeading(ctx, section.heading, { gap: 0, continued: true });
    }

    const baseline = ctx.y - 10.4;
    drawText(ctx, label, CONTENT_LEFT, baseline, {
      font: ctx.fonts.sans,
      size: labelFontSize,
      color: ctx.colors.inkMuted,
      tracking: labelTracking,
    });

    valueLines.forEach((line, index) => {
      const lineWidth = ctx.fonts.mono.widthOfTextAtSize(line, valueSize);
      drawText(ctx, line, CONTENT_RIGHT - lineWidth, baseline - index * 11.8, {
        font: valueFont,
        size: valueSize,
        color: row.emphasis ? ctx.colors.inkStrong : ctx.colors.ink,
      });
    });

    const ruleY = ctx.y - rowHeight + 2.4;
    hairline(ctx, ruleY, CONTENT_LEFT, CONTENT_RIGHT, 0.35, ctx.colors.lineSoft);
    ctx.y -= rowHeight;
  }
  ctx.y -= 4;
}

interface TableColumnMetrics {
  label: string;
  x: number;
  width: number;
  align: 'left' | 'right';
}

function tableColumnMetrics(ctx: Report, section: TableSection): TableColumnMetrics[] {
  const columns = section.columns;
  if (columns.length === 0) return [];
  const gap = 9;
  const available = CONTENT_WIDTH - gap * (columns.length - 1);

  const naturals = columns.map((column, index) => {
    const label = `${column.label}${column.unit ? ` (${column.unit})` : ''}`.toUpperCase();
    let natural = trackedWidth(ctx, label, ctx.fonts.sansBold, 7.2, 0.55) + 4;
    let widestCell = 0;
    for (const row of section.rows) {
      const cell = cellText(row[index] ?? '');
      const width =
        column.align === 'right'
          ? ctx.fonts.mono.widthOfTextAtSize(cell, 8.6)
          : ctx.fonts.sans.widthOfTextAtSize(cell, 8.6);
      if (width > widestCell) widestCell = width;
    }
    natural = Math.max(natural, widestCell + 4, 26);
    return natural;
  });

  const naturalTotal = naturals.reduce((sum, value) => sum + value, 0);
  const scale =
    naturalTotal > 0 ? Math.min(2.4, Math.max(0.35, available / naturalTotal)) : 1;

  let x = CONTENT_LEFT;
  return columns.map((column, index) => {
    const width = naturals[index]! * scale;
    const metrics: TableColumnMetrics = {
      label: `${column.label}${column.unit ? ` (${column.unit})` : ''}`.toUpperCase(),
      x,
      width,
      align: column.align === 'right' ? 'right' : 'left',
    };
    x += width + gap;
    return metrics;
  });
}

function drawTableHeaderRow(
  ctx: Report,
  metrics: TableColumnMetrics[],
): void {
  const baseline = ctx.y - 10;
  for (const column of metrics) {
    const text = truncateToWidth(
      ctx,
      column.label,
      ctx.fonts.sansBold,
      7.2,
      Math.max(12, column.width - 2),
      0.55,
    );
    if (column.align === 'right') {
      drawTextRight(ctx, text, column.x + column.width, baseline, {
        font: ctx.fonts.sansBold,
        size: 7.2,
        color: ctx.colors.inkSoft,
        tracking: 0.55,
      });
    } else {
      drawText(ctx, text, column.x, baseline, {
        font: ctx.fonts.sansBold,
        size: 7.2,
        color: ctx.colors.inkSoft,
        tracking: 0.55,
      });
    }
  }
  hairline(ctx, ctx.y - 14.6, CONTENT_LEFT, CONTENT_RIGHT, 0.7, ctx.colors.inkSoft);
  ctx.y -= 17.4;
}

function drawTableRow(
  ctx: Report,
  section: TableSection,
  metrics: TableColumnMetrics[],
  row: Array<string | number>,
): void {
  const baseline = ctx.y - 9.4;
  metrics.forEach((column, index) => {
    const text = truncateToWidth(
      ctx,
      cellText(row[index] ?? ''),
      column.align === 'right' ? ctx.fonts.mono : ctx.fonts.sans,
      8.6,
      Math.max(10, column.width - 2),
    );
    if (column.align === 'right') {
      drawTextRight(ctx, text, column.x + column.width, baseline, {
        font: ctx.fonts.mono,
        size: 8.6,
        color: ctx.colors.ink,
      });
    } else {
      drawText(ctx, text, column.x, baseline, {
        font: ctx.fonts.sans,
        size: 8.6,
        color: ctx.colors.ink,
      });
    }
  });
  hairline(ctx, ctx.y - 12.8, CONTENT_LEFT, CONTENT_RIGHT, 0.3, ctx.colors.lineSoft);
  ctx.y -= 13.2;
}

function drawTableSection(ctx: Report, section: TableSection): void {
  drawSectionHeading(ctx, section.heading);
  const metrics = tableColumnMetrics(ctx, section);

  if (metrics.length === 0) {
    drawText(ctx, 'No data rows.', CONTENT_LEFT, ctx.y - 10, {
      font: ctx.fonts.sans,
      size: 8.5,
      color: ctx.colors.inkMuted,
    });
    ctx.y -= 18;
    return;
  }

  drawTableHeaderRow(ctx, metrics);

  for (const row of section.rows) {
    if (ctx.y - 13.2 < BODY_BOTTOM) {
      addPage(ctx, false);
      drawSectionHeading(ctx, section.heading, { gap: 0, continued: true });
      drawTableHeaderRow(ctx, metrics);
    }
    drawTableRow(ctx, section, metrics, row);
  }

  if (section.footnote) {
    ctx.y -= 6;
    const footnoteLines = wrapText(ctx, section.footnote, ctx.fonts.sans, 8, CONTENT_WIDTH);
    for (const line of footnoteLines) {
      ensureSpace(ctx, 12);
      ctx.y -= 11.5;
      drawText(ctx, line, CONTENT_LEFT, ctx.y, {
        font: ctx.fonts.sans,
        size: 8,
        color: ctx.colors.inkMuted,
      });
    }
    ctx.y -= 4;
  } else {
    ctx.y -= 4;
  }
}

function drawTextSection(ctx: Report, section: TextSection): void {
  drawSectionHeading(ctx, section.heading);
  for (const paragraph of section.paragraphs) {
    const lines = wrapText(ctx, paragraph, ctx.fonts.sans, 9.4, CONTENT_WIDTH);
    for (const line of lines) {
      if (ensureSpace(ctx, 13.8)) {
        drawSectionHeading(ctx, section.heading, { gap: 0, continued: true });
      }
      ctx.y -= 10;
      drawText(ctx, line, CONTENT_LEFT, ctx.y, {
        font: ctx.fonts.sans,
        size: 9.4,
        color: ctx.colors.ink,
      });
      ctx.y -= 3.8;
    }
    ctx.y -= 6;
  }
}

function drawNotesSection(ctx: Report, section: NotesSection): void {
  drawSectionHeading(ctx, section.heading);
  for (const rawLine of section.lines) {
    const lines = wrapText(ctx, rawLine, ctx.fonts.sans, 8.6, CONTENT_WIDTH - 14);
    for (let index = 0; index < lines.length; index += 1) {
      if (ensureSpace(ctx, 12.6)) {
        drawSectionHeading(ctx, section.heading, { gap: 0, continued: true });
      }
      ctx.y -= 9;
      const line = lines[index]!;
      if (index === 0) {
        drawText(ctx, '·', CONTENT_LEFT, ctx.y, {
          font: ctx.fonts.sans,
          size: 8.6,
          color: ctx.colors.signal,
        });
      }
      drawText(ctx, line, CONTENT_LEFT + 10, ctx.y, {
        font: ctx.fonts.sans,
        size: 8.6,
        color: ctx.colors.inkSoft,
      });
      ctx.y -= 3.6;
    }
    ctx.y -= 4.5;
  }
}

/* ------------------------------------------------------------------------- */
/* optional chart (rasterised in the browser; never fatal)                    */
/* ------------------------------------------------------------------------- */

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('chart image failed to load'));
    image.src = source;
  });
}

/**
 * SVG/PNG data URL → PNG bytes, via Blob → Image → canvas (as specified).
 * Returns null (silently) whenever the environment cannot rasterise — SSR,
 * tainted canvas, unsupported format, decode error. A chart is garnish; it
 * must never break a report.
 */
async function rasteriseChart(
  pdf: PdfModule,
  doc: PDFDocument,
  source: string,
  maxWidth: number,
  maxHeight: number,
): Promise<{ image: PDFImage; width: number; height: number } | null> {
  if (typeof document === 'undefined' || typeof Image === 'undefined') return null;

  try {
    const response = await fetch(source);
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    try {
      const image = await loadImage(objectUrl);
      const naturalWidth = image.naturalWidth || 0;
      const naturalHeight = image.naturalHeight || 0;

      let width = maxWidth;
      let height = maxWidth * 0.38;
      if (naturalWidth > 0 && naturalHeight > 0) {
        height = (maxWidth * naturalHeight) / naturalWidth;
        if (height > maxHeight) {
          height = maxHeight;
          width = (maxHeight * naturalWidth) / naturalHeight;
        }
      }

      const pixelRatio = Math.min(2.5, Math.max(1, 1600 / Math.max(1, width)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(width * pixelRatio));
      canvas.height = Math.max(1, Math.round(height * pixelRatio));
      const context = canvas.getContext('2d');
      if (!context) return null;
      context.fillStyle = '#F6F3EC';
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      const pngDataUrl = canvas.toDataURL('image/png');
      if (!pngDataUrl || !pngDataUrl.startsWith('data:image/png')) return null;
      const embedded = await doc.embedPng(pngDataUrl);
      return { image: embedded, width, height };
    } finally {
      URL.revokeObjectURL(objectUrl);
    }
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------------- */
/* parameters + chart block                                                   */
/* ------------------------------------------------------------------------- */

function drawParameters(ctx: Report, meta: ExportMeta): void {
  const parameters = meta.parameters ?? [];
  if (parameters.length === 0) return;
  drawKvSection(ctx, {
    kind: 'kv',
    heading: 'Parameters',
    rows: parameters.map((parameter) => ({
      label: parameter.label,
      value: String(parameter.value),
    })),
  });
}

async function drawChart(
  ctx: Report,
  chartSvg: string | undefined,
): Promise<void> {
  if (!chartSvg) return;
  const maxWidth = CONTENT_WIDTH;
  const maxHeight = 220;
  const chart = await rasteriseChart(ctx.pdf, ctx.doc, chartSvg, maxWidth, maxHeight);
  if (!chart) return;

  /* start a clean page when the figure would not fit as a block */
  ensureSpace(ctx, chart.height + 26);
  ctx.y -= 10;
  const x = CONTENT_LEFT + (CONTENT_WIDTH - chart.width) / 2;
  ctx.page.drawRectangle({
    x: x - 1,
    y: ctx.y - chart.height - 1,
    width: chart.width + 2,
    height: chart.height + 2,
    borderColor: ctx.colors.line,
    borderWidth: 0.5,
    color: ctx.colors.paper,
  });
  ctx.page.drawImage(chart.image, {
    x,
    y: ctx.y - chart.height,
    width: chart.width,
    height: chart.height,
  });
  ctx.y -= chart.height + 16;
}

/* ------------------------------------------------------------------------- */
/* footer + metadata                                                          */
/* ------------------------------------------------------------------------- */

function drawFooters(ctx: Report): void {
  const total = ctx.pages.length;
  ctx.pages.forEach((page, index) => {
    page.drawLine({
      start: { x: CONTENT_LEFT, y: FOOTER_RULE_Y },
      end: { x: CONTENT_RIGHT, y: FOOTER_RULE_Y },
      thickness: 0.5,
      color: ctx.colors.line,
    });
    page.drawLine({
      start: { x: CONTENT_LEFT, y: FOOTER_RULE_Y },
      end: { x: CONTENT_LEFT + 22, y: FOOTER_RULE_Y },
      thickness: 1,
      color: ctx.colors.signal,
    });
    page.drawText(sanitizeText(FOOTER_TEXT), {
      x: CONTENT_LEFT,
      y: FOOTER_BASELINE,
      size: 7,
      font: ctx.fonts.sans,
      color: ctx.colors.inkMuted,
    });
    const pageLabel = `Page ${index + 1} of ${total}`;
    page.drawText(pageLabel, {
      x: CONTENT_RIGHT - ctx.fonts.mono.widthOfTextAtSize(pageLabel, 7.5),
      y: FOOTER_BASELINE - 0.5,
      size: 7.5,
      font: ctx.fonts.mono,
      color: ctx.colors.inkMuted,
    });
  });
}

function applyMetadata(ctx: Report, documentTitle: string | undefined): void {
  const { doc } = ctx;
  const title = sanitizeText(documentTitle || ctx.title) || 'Geodesia report';
  doc.setTitle(title);
  doc.setAuthor('Geodesia');
  doc.setSubject(`Survey computation report - geodesia.report/v1 - ${sanitizeText(ctx.tool)}`);
  doc.setKeywords(['Geodesia', 'survey', 'WGS 84', sanitizeText(ctx.tool)]);
  doc.setProducer('Geodesia (pdf-lib, client-side)');
  doc.setCreator('https://geodesia.online');
  doc.setCreationDate(ctx.meta.generatedAt ?? new Date());
  doc.setModificationDate(new Date(ctx.meta.generatedAt?.getTime() ?? Date.now()));
}

/* ------------------------------------------------------------------------- */
/* public API                                                                 */
/* ------------------------------------------------------------------------- */

/** Build the PDF report and return its bytes (used by tests / previews). */
export async function buildPDF(spec: PdfReportSpec): Promise<Uint8Array> {
  const pdf = (await import('pdf-lib')) as PdfModule;
  const { PDFDocument, StandardFonts } = pdf;

  const doc = await PDFDocument.create();
  const fonts: Fonts = {
    sans: await doc.embedFont(StandardFonts.Helvetica),
    sansBold: await doc.embedFont(StandardFonts.HelveticaBold),
    mono: await doc.embedFont(StandardFonts.Courier),
    monoBold: await doc.embedFont(StandardFonts.CourierBold),
  };

  const colors = Object.fromEntries(
    (Object.keys(PALETTE) as PaletteKey[]).map((key) => [
      key,
      pdf.rgb(PALETTE[key][0] / 255, PALETTE[key][1] / 255, PALETTE[key][2] / 255),
    ]),
  ) as Colors;

  const generatedAt = spec.meta.generatedAt ?? new Date();
  const firstPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  const ctx: Report = {
    pdf,
    doc,
    fonts,
    colors,
    pages: [firstPage],
    page: firstPage,
    y: 0,
    meta: spec.meta,
    title: String(spec.meta.title ?? ''),
    subtitle: String(spec.meta.subtitle ?? ''),
    tool: String(spec.meta.tool ?? ''),
    stamp: stampDate(generatedAt),
  };
  /* dress page 1: survey-paper ground + full masthead (sets ctx.y) */
  paperGround(ctx);
  drawMasthead(ctx);

  drawParameters(ctx, spec.meta);
  await drawChart(ctx, spec.chartSvg);

  for (const section of spec.sections) {
    switch (section.kind) {
      case 'kv':
        drawKvSection(ctx, section);
        break;
      case 'table':
        drawTableSection(ctx, section);
        break;
      case 'text':
        drawTextSection(ctx, section);
        break;
      case 'notes':
        drawNotesSection(ctx, section);
        break;
    }
  }

  drawFooters(ctx);
  applyMetadata(ctx, spec.documentTitle);

  return doc.save();
}

/**
 * Generate and download a client-side PDF report.
 * Derives the download name from the report metadata; a no-op outside the
 * browser (tests, SSR) so call sites stay environment-agnostic.
 */
export async function exportPDF(spec: PdfReportSpec): Promise<void> {
  const bytes = await buildPDF(spec);
  if (typeof document === 'undefined' || typeof URL === 'undefined') return;
  if (typeof URL.createObjectURL !== 'function') return;

  const generatedAt = spec.meta.generatedAt ?? new Date();
  const filename = pdfFilename(spec.meta, generatedAt);
  const blob = new Blob([toArrayBuffer(bytes)], { type: 'application/pdf' });
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
/* small environment-free helpers (kept local to avoid a cycle with index.ts) */
/* ------------------------------------------------------------------------- */

/** ISO-8601 UTC, second precision — mirrors `timestamp()` in index.ts. */
function stampDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** `geodesia-<slug>-<ISO stamp with colons replaced>.pdf`. */
function pdfFilename(meta: ExportMeta, date: Date): string {
  const slug = String(meta.tool ?? 'report')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return `geodesia-${slug || 'report'}-${stampDate(date).replace(/:/g, '-')}.pdf`;
}

/** Copy a Uint8Array into a plain ArrayBuffer (`BlobPart` typing + isolation). */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  return copy;
}
