#!/usr/bin/env node
/**
 * GEODESIA — STATIC OUTPUT AUDIT
 * ===========================================================================
 * Post-build QA for `dist/` (plain Node 24, zero dependencies).
 *
 *   node scripts/check-output.mjs [--dist <dir>] [--base <url>] [--help]
 *
 * Checks SEO/meta/JSON-LD, sitemap ↔ robots ↔ pages agreement, forbidden
 * legacy strings, third-party CDN leakage, broken internal links, missing
 * referenced assets, asset-reference integrity (every referenced
 * `_assets/<name>` must exist, and no built JS may preload a CSS chunk that
 * Astro inlined), the CSP / service-worker basemap-host contract, and the
 * first-load JS budget / lazy-heavy-library leakage.
 * Prints a PASS/FAIL table plus a precise failure list and exits non-zero on
 * any failure.
 *
 * The HTML parsing is a deliberately light manual parse (tag regex + attribute
 * regex) — enough for the static output Astro produces, no DOM dependency.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

/* ------------------------------------------------------------------------- */
/* configuration                                                              */
/* ------------------------------------------------------------------------- */

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(SCRIPT_DIR, '..');

const MAX_TITLE = 65;
const MAX_DESCRIPTION = 165;
/** First-load JS budget is measured as *compressed transfer* (what the browser
 *  actually downloads). Raw size is reported alongside for context. */
const JS_BUDGET_BYTES = 120 * 1024;

const USAGE = `Geodesia static output audit

Usage: node scripts/check-output.mjs [options]

Options:
  --dist <dir>   dist directory to audit (default: <repo>/dist)
  --base <url>   canonical site origin (default: https://geodesia.online)
  --offline      skip the network reachability probe (warning-only check)
  --help         show this help`;

function parseArgs(argv) {
  const options = { dist: null, base: 'https://geodesia.online', offline: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      console.log(USAGE);
      process.exit(0);
    } else if (arg === '--dist') {
      options.dist = argv[++index];
    } else if (arg.startsWith('--dist=')) {
      options.dist = arg.slice('--dist='.length);
    } else if (arg === '--base') {
      options.base = argv[++index];
    } else if (arg.startsWith('--base=')) {
      options.base = arg.slice('--base='.length);
    } else if (arg === '--offline' || arg === '--skip-network') {
      options.offline = true;
    } else {
      console.error(`Unknown argument: ${arg}\n\n${USAGE}`);
      process.exit(2);
    }
  }
  if (!options.dist) options.dist = join(PROJECT_ROOT, 'dist');
  if (process.env.GEODESIA_QA_OFFLINE === '1') options.offline = true;
  options.base = options.base.replace(/\/+$/, '');
  return options;
}

const OPTIONS = parseArgs(process.argv.slice(2));
const DIST = resolve(OPTIONS.dist);
const SITE = OPTIONS.base;
const SITE_HOST = safeHost(SITE);

/* ------------------------------------------------------------------------- */
/* generic helpers                                                            */
/* ------------------------------------------------------------------------- */

const results = [];
const allFailures = [];
const warnings = [];

function addWarning(check, message) {
  warnings.push({ check, message });
}

function addResult(name, detail, failures = []) {
  results.push({ name, detail, failures });
  for (const failure of failures) allFailures.push({ check: name, ...failure });
}

function runCheck(name, check) {
  try {
    const { detail, failures = [] } = check();
    addResult(name, detail, failures);
  } catch (error) {
    addResult(name, `check threw: ${error.message}`, [
      {
        file: '-',
        message: `Internal check error: ${error.message}`,
        fix: 'Fix the audit script before trusting the result.',
      },
    ]);
  }
}

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(path));
    else files.push(path);
  }
  return files;
}

function relativeFrom(root, absolute) {
  return relative(root, absolute).split(sep).join('/');
}

function readText(file) {
  return readFileSync(file, 'utf8');
}

function bytesOf(file) {
  return statSync(file).size;
}

function safeHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return url.replace(/^https?:\/\//, '').split('/')[0];
  }
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function normaliseRoutePath(pathname) {
  const clean = pathname.replace(/\/+$/, '');
  return clean === '' ? '/' : clean;
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} kB`;
  return `${bytes} B`;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function decodeEntities(value) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (full, code) => {
    const lower = code.toLowerCase();
    if (lower.startsWith('#x')) {
      const point = Number.parseInt(lower.slice(2), 16);
      return Number.isFinite(point) ? String.fromCodePoint(point) : full;
    }
    if (lower.startsWith('#')) {
      const point = Number.parseInt(lower.slice(1), 10);
      return Number.isFinite(point) ? String.fromCodePoint(point) : full;
    }
    return named[lower] ?? full;
  });
}

function cleanText(value) {
  return decodeEntities(String(value ?? ''))
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visible text of an HTML document (scripts, styles and tags stripped). */
function plainHtmlText(html) {
  return cleanText(
    String(html)
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  );
}

function parseAttributes(tag) {
  const attributes = {};
  const inner = tag
    .replace(/^<\s*[a-zA-Z][a-zA-Z0-9:-]*/, '')
    .replace(/\/?>$/, '');
  const pattern = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;
  while ((match = pattern.exec(inner)) !== null) {
    const name = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? '';
    attributes[name] = decodeEntities(value);
  }
  return attributes;
}

function* tags(html, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>`, 'gi');
  let match;
  while ((match = pattern.exec(html)) !== null) yield match[0];
}

function tagAttribute(html, tagName, attribute) {
  for (const tag of tags(html, tagName)) {
    const attributes = parseAttributes(tag);
    if (attributes[attribute] !== undefined) return attributes[attribute];
  }
  return undefined;
}

/* ------------------------------------------------------------------------- */
/* load dist                                                                  */
/* ------------------------------------------------------------------------- */

if (!existsSync(DIST) || !statSync(DIST).isDirectory()) {
  console.error(`\nGEODESIA OUTPUT AUDIT — FAIL`);
  console.error(`dist directory not found: ${DIST}`);
  console.error('Run `npx astro build` first.\n');
  process.exit(1);
}

const allFiles = walk(DIST);
const relFiles = allFiles.map((file) => relativeFrom(DIST, file));
const fileSet = new Set(relFiles);

/* ------------------------------------------------------------------------- */
/* parse pages                                                                */
/* ------------------------------------------------------------------------- */

function parsePage(file) {
  const relPath = relativeFrom(DIST, file);
  const html = readText(file);
  const route = pageRoute(relPath);

  const metaTags = [];
  const linkTags = [];
  const scriptTags = [];

  for (const tag of tags(html, 'meta')) metaTags.push(parseAttributes(tag));
  for (const tag of tags(html, 'link')) linkTags.push(parseAttributes(tag));

  const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let scriptMatch;
  while ((scriptMatch = scriptPattern.exec(html)) !== null) {
    scriptTags.push({
      attributes: parseAttributes(`<script${scriptMatch[1]}>`),
      content: scriptMatch[2] ?? '',
      contentBytes: Buffer.byteLength(scriptMatch[2] ?? ''),
    });
  }

  const metaByName = new Map();
  const metaByProperty = new Map();
  for (const attributes of metaTags) {
    const content = cleanText(attributes.content ?? '');
    if (attributes.name) metaByName.set(attributes.name.toLowerCase(), content);
    if (attributes.property) metaByProperty.set(attributes.property.toLowerCase(), content);
  }

  const jsonLd = scriptTags
    .filter((script) => (script.attributes.type ?? '').toLowerCase() === 'application/ld+json')
    .map((script) => ({ content: script.content.trim(), attributes: script.attributes }));

  const anchors = [];
  for (const tag of tags(html, 'a')) {
    const attributes = parseAttributes(tag);
    if (attributes.href !== undefined) anchors.push(attributes.href);
  }

  const h1Count = (html.match(/<h1\b/gi) ?? []).length;
  const htmlTag = (html.match(/<html\b[^>]*>/i) ?? [''])[0];
  const lang = cleanText(parseAttributes(htmlTag).lang ?? '');

  const canonicalLinks = linkTags.filter((attributes) =>
    (attributes.rel ?? '').toLowerCase().split(/\s+/).includes('canonical'),
  );

  return {
    file,
    relPath,
    route,
    is404: relPath === '404.html',
    html,
    lang,
    title: cleanText(tagContent(html, 'title') ?? ''),
    description: metaByName.get('description') ?? '',
    robots: metaByName.get('robots') ?? '',
    metaByName,
    metaByProperty,
    linkTags,
    scriptTags,
    jsonLd,
    anchors,
    h1Count,
    canonical: canonicalLinks.length > 0 ? decodeEntities(canonicalLinks[0].href ?? '').trim() : '',
    canonicalCount: canonicalLinks.length,
    og: {
      title: metaByProperty.get('og:title') ?? '',
      description: metaByProperty.get('og:description') ?? '',
      image: metaByProperty.get('og:image') ?? '',
      url: metaByProperty.get('og:url') ?? '',
      type: metaByProperty.get('og:type') ?? '',
    },
    twitterCard: metaByName.get('twitter:card') ?? '',
  };
}

function tagContent(html, name) {
  const match = html.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`, 'i'));
  return match ? match[1] : null;
}

function pageRoute(relPath) {
  if (relPath === 'index.html') return '/';
  if (relPath.endsWith('/index.html')) return `/${relPath.slice(0, -'/index.html'.length)}`;
  return `/${relPath.replace(/\.html$/, '')}`;
}

function expectedCanonical(route) {
  return route === '/' ? `${SITE}/` : `${SITE}${route}`;
}

const pages = relFiles
  .filter((relPath) => relPath.endsWith('.html'))
  .map((relPath) => parsePage(join(DIST, relPath)));

const homePage = pages.find((page) => page.route === '/') ?? null;
/** Every non-404 page must satisfy the full SEO contract. */
const contentPages = pages.filter((page) => !page.is404);
/** Pages allowed in the sitemap (noindex pages are excluded by definition). */
const indexablePages = contentPages.filter((page) => !/noindex/i.test(page.robots));

/* ------------------------------------------------------------------------- */
/* check: HTML shell + SEO metadata                                           */
/* ------------------------------------------------------------------------- */

runCheck('html:pages', () => ({
  detail: `${pages.length} html page(s), ${contentPages.length} content page(s), ${pages.length - contentPages.length} 404`,
  failures:
    pages.length === 0
      ? [{ file: 'dist/', message: 'No .html pages found in dist/.', fix: 'Run the build; check astro output dir.' }]
      : [],
}));

runCheck('html:lang', () => {
  const failures = pages
    .filter((page) => !page.lang)
    .map((page) => ({
      file: page.relPath,
      message: '<html> is missing a non-empty lang attribute.',
      fix: 'Set <html lang="en"> in src/layouts/BaseLayout.astro.',
    }));
  return { detail: `${pages.length - failures.length}/${pages.length} pages declare <html lang>`, failures };
});

runCheck('seo:title', () => {
  const failures = [];
  const seen = new Map();
  for (const page of pages) {
    if (!page.title) {
      failures.push({ file: page.relPath, message: 'Missing <title>.', fix: 'Add a title to the page/layout.' });
      continue;
    }
    const length = [...page.title].length;
    if (length > MAX_TITLE) {
      failures.push({
        file: page.relPath,
        message: `Title is ${length} chars (max ${MAX_TITLE}): "${page.title}"`,
        fix: 'Shorten the title/meta title.',
      });
    }
    const key = page.title.toLowerCase();
    if (seen.has(key)) {
      failures.push({
        file: page.relPath,
        message: `Duplicate title with ${seen.get(key)}: "${page.title}"`,
        fix: 'Make every page title unique.',
      });
    } else {
      seen.set(key, page.relPath);
    }
  }
  return { detail: `${pages.length - failures.length}/${pages.length} titles present, unique, ≤${MAX_TITLE} chars`, failures };
});

runCheck('seo:description', () => {
  const failures = [];
  const seen = new Map();
  for (const page of pages) {
    if (!page.description) {
      failures.push({
        file: page.relPath,
        message: 'Missing <meta name="description">.',
        fix: 'Add a unique 80–165 char description per page.',
      });
      continue;
    }
    const length = [...page.description].length;
    if (length > MAX_DESCRIPTION) {
      failures.push({
        file: page.relPath,
        message: `Description is ${length} chars (max ${MAX_DESCRIPTION}).`,
        fix: 'Trim the meta description.',
      });
    }
    const key = page.description.toLowerCase();
    if (seen.has(key)) {
      failures.push({
        file: page.relPath,
        message: `Duplicate description with ${seen.get(key)}.`,
        fix: 'Write a page-specific description.',
      });
    } else {
      seen.set(key, page.relPath);
    }
  }
  return { detail: `${pages.length - failures.length}/${pages.length} descriptions present, unique, ≤${MAX_DESCRIPTION} chars`, failures };
});

runCheck('seo:canonical', () => {
  const failures = [];
  for (const page of contentPages) {
    const expected = expectedCanonical(page.route);
    if (page.canonicalCount === 0) {
      failures.push({
        file: page.relPath,
        message: 'Missing <link rel="canonical">.',
        fix: `Add <link rel="canonical" href="${expected}">.`,
      });
    } else if (page.canonicalCount > 1) {
      failures.push({
        file: page.relPath,
        message: `Found ${page.canonicalCount} canonical links; exactly one is required.`,
        fix: 'Emit a single canonical in BaseLayout.',
      });
    } else if (page.canonical !== expected) {
      failures.push({
        file: page.relPath,
        message: `Canonical is "${page.canonical}" but route requires "${expected}" (absolute, no trailing slash except /).`,
        fix: 'Derive canonical from Astro.url.pathname; do not append a trailing slash.',
      });
    }
  }
  return { detail: `${contentPages.length} page(s) checked against ${SITE}/<route> (no trailing slash)`, failures };
});

runCheck('seo:open-graph', () => {
  const failures = [];
  for (const page of contentPages) {
    const missing = [];
    if (!page.og.title) missing.push('og:title');
    if (!page.og.description) missing.push('og:description');
    if (!page.og.image) missing.push('og:image');
    if (!page.og.url) missing.push('og:url');
    if (!page.twitterCard) missing.push('twitter:card');
    if (missing.length > 0) {
      failures.push({ file: page.relPath, message: `Missing: ${missing.join(', ')}.`, fix: 'Add the missing Open Graph/Twitter meta tags.' });
    }
    if (page.og.url && page.og.url !== page.canonical) {
      failures.push({
        file: page.relPath,
        message: `og:url "${page.og.url}" does not match canonical "${page.canonical}".`,
        fix: 'Use the canonical URL for og:url.',
      });
    }
    if (page.og.image) {
      const parsed = safeUrl(page.og.image);
      if (!parsed || parsed.protocol !== 'https:') {
        failures.push({
          file: page.relPath,
          message: `og:image is not an absolute https URL: "${page.og.image}".`,
          fix: 'Point og:image at a self-hosted https asset (e.g. /og/geodesia-og.png).',
        });
      } else if (parsed.host === SITE_HOST) {
        const asset = parsed.pathname.replace(/^\//, '');
        if (!fileSet.has(asset)) {
          failures.push({
            file: page.relPath,
            message: `og:image target does not exist in dist: ${parsed.pathname}.`,
            fix: 'Run scripts/generate-brand-assets.mjs before the build.',
          });
        }
      } else {
        failures.push({
          file: page.relPath,
          message: `og:image is third-party (${parsed.host}); social cards must be self-hosted.`,
          fix: 'Host the card under /og/ and reference it by path.',
        });
      }
    }
  }
  return { detail: `${contentPages.length} page(s) checked for og:title/description/image/url + twitter:card`, failures };
});

runCheck('seo:h1', () => {
  const failures = pages
    .filter((page) => page.h1Count !== 1)
    .map((page) => ({
      file: page.relPath,
      message: `Found ${page.h1Count} <h1> element(s); exactly one is required.`,
      fix: 'Keep one page-level h1; demote section titles to h2.',
    }));
  return { detail: `${pages.length - failures.length}/${pages.length} pages have exactly one <h1>`, failures };
});

/* ------------------------------------------------------------------------- */
/* check: JSON-LD                                                             */
/* ------------------------------------------------------------------------- */

function collectJsonLdTypes(node, types, contexts) {
  if (Array.isArray(node)) {
    for (const item of node) collectJsonLdTypes(item, types, contexts);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (node['@context'] !== undefined) contexts.push(node['@context']);
  const raw = node['@type'];
  if (typeof raw === 'string') types.add(raw);
  else if (Array.isArray(raw)) for (const item of raw) if (typeof item === 'string') types.add(item);
  if (node['@graph']) collectJsonLdTypes(node['@graph'], types, contexts);
}

runCheck('jsonld:parse', () => {
  const failures = [];
  let documents = 0;
  for (const page of pages) {
    for (const [index, block] of page.jsonLd.entries()) {
      documents += 1;
      if (!block.content) {
        failures.push({
          file: page.relPath,
          message: `JSON-LD block #${index + 1} is empty.`,
          fix: 'Remove the empty script or populate the schema.',
        });
        continue;
      }
      try {
        const parsed = JSON.parse(block.content);
        if (!parsed || typeof parsed !== 'object') throw new Error('not a JSON object');
      } catch (error) {
        failures.push({
          file: page.relPath,
          message: `JSON-LD block #${index + 1} does not parse: ${error.message}`,
          fix: 'Validate the JSON-LD builder output (src/seo/schema.ts).',
        });
      }
    }
  }
  return { detail: `${documents} JSON-LD block(s) parsed`, failures };
});

runCheck('jsonld:required-types', () => {
  const failures = [];
  if (!homePage) {
    return {
      detail: 'no home page',
      failures: [{ file: 'index.html', message: 'No home page found.', fix: 'Build index.astro to dist/index.html.' }],
    };
  }
  const types = new Set();
  const contexts = [];
  for (const block of homePage.jsonLd) {
    try {
      collectJsonLdTypes(JSON.parse(block.content), types, contexts);
    } catch {
      /* already reported by jsonld:parse */
    }
  }
  const hasApplication = types.has('WebApplication') || types.has('SoftwareApplication');
  const required = [
    ['Organization', types.has('Organization')],
    ['WebSite', types.has('WebSite')],
    ['WebApplication|SoftwareApplication', hasApplication],
  ];
  for (const [label, present] of required) {
    if (!present) {
      failures.push({
        file: homePage.relPath,
        message: `Home page JSON-LD is missing required @type ${label}.`,
        fix: 'Add the organisation/site/application schema on the home page (src/seo/schema.ts).',
      });
    }
  }
  if (contexts.length === 0) {
    failures.push({
      file: homePage.relPath,
      message: 'Home page JSON-LD has no @context.',
      fix: 'Every JSON-LD document needs "@context": "https://schema.org".',
    });
  }
  return {
    detail: `home types: ${[...types].sort().join(', ') || '(none)'}`,
    failures,
  };
});

/* ------------------------------------------------------------------------- */
/* check: sitemap + robots                                                    */
/* ------------------------------------------------------------------------- */

const sitemapFile = join(DIST, 'sitemap.xml');
const robotsFile = join(DIST, 'robots.txt');
let sitemapLocs = [];

runCheck('sitemap:exists', () => {
  if (!existsSync(sitemapFile)) {
    return {
      detail: 'missing',
      failures: [
        {
          file: 'sitemap.xml',
          message: 'dist/sitemap.xml does not exist.',
          fix: 'Enable @astrojs/sitemap in astro.config.mjs (site must be https://geodesia.online).',
        },
      ],
    };
  }
  return { detail: `${formatBytes(bytesOf(sitemapFile))}`, failures: [] };
});

runCheck('sitemap:xml', () => {
  if (!existsSync(sitemapFile)) return { detail: 'skipped (missing)', failures: [] };
  const xml = readText(sitemapFile);
  const failures = [];
  if (!/^\s*<\?xml/i.test(xml)) {
    failures.push({ file: 'sitemap.xml', message: 'Missing XML declaration.', fix: 'Let @astrojs/sitemap generate the file.' });
  }
  if (!/<urlset\b[^>]*>/i.test(xml) || !/<\/urlset>/i.test(xml)) {
    failures.push({ file: 'sitemap.xml', message: 'Missing <urlset> element.', fix: 'Regenerate the sitemap.' });
  }
  const urlOpen = (xml.match(/<url>/g) ?? []).length;
  const urlClose = (xml.match(/<\/url>/g) ?? []).length;
  const locOpen = (xml.match(/<loc>/g) ?? []).length;
  const locClose = (xml.match(/<\/loc>/g) ?? []).length;
  if (urlOpen !== urlClose || locOpen !== locClose || urlOpen !== locOpen) {
    failures.push({
      file: 'sitemap.xml',
      message: `Unbalanced tags: <url>${urlOpen}/${urlClose} <loc>${locOpen}/${locClose}.`,
      fix: 'Regenerate the sitemap; inspect if it was hand-edited.',
    });
  }
  sitemapLocs = [...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)].map((match) =>
    cleanText(match[1]),
  );
  if (sitemapLocs.length === 0) {
    failures.push({ file: 'sitemap.xml', message: 'No <loc> entries found.', fix: 'Ensure at least the home page is listed.' });
  }
  return { detail: `${sitemapLocs.length} <loc> entries, ${formatBytes(bytesOf(sitemapFile))}`, failures };
});

runCheck('sitemap:coverage', () => {
  if (!existsSync(sitemapFile)) return { detail: 'skipped (missing)', failures: [] };
  const failures = [];
  const listed = new Set();
  const listedPaths = [];
  for (const loc of sitemapLocs) {
    const parsed = safeUrl(loc);
    if (!parsed) {
      failures.push({ file: 'sitemap.xml', message: `Invalid URL: "${loc}".`, fix: 'Use absolute https URLs.' });
      continue;
    }
    if (parsed.protocol !== 'https:') {
      failures.push({ file: 'sitemap.xml', message: `Non-https sitemap URL: "${loc}".`, fix: 'Canonical origin must be https.' });
    }
    if (parsed.host !== SITE_HOST) {
      failures.push({ file: 'sitemap.xml', message: `Foreign host in sitemap: "${loc}".`, fix: `Only ${SITE_HOST} URLs belong in the sitemap.` });
    }
    if (parsed.hash || parsed.search) {
      failures.push({ file: 'sitemap.xml', message: `Sitemap URL has query/hash: "${loc}".`, fix: 'List clean canonical routes only.' });
    }
    const path = normaliseRoutePath(parsed.pathname);
    if (listed.has(path)) {
      failures.push({ file: 'sitemap.xml', message: `Duplicate sitemap entry: "${loc}".`, fix: 'Deduplicate routes.' });
    }
    listed.add(path);
    listedPaths.push({ loc, path });
  }

  const indexableRoutes = new Map(indexablePages.map((page) => [normaliseRoutePath(page.route), page]));
  for (const [route, page] of indexableRoutes) {
    if (!listed.has(route)) {
      failures.push({
        file: page.relPath,
        message: `Indexable page ${route} is missing from sitemap.xml.`,
        fix: 'Allow the route in astro.config.mjs sitemap filter; avoid noindex on shipped pages.',
      });
    }
  }
  for (const { loc, path } of listedPaths) {
    if (!indexableRoutes.has(path)) {
      const known = pages.some((page) => !page.is404 && normaliseRoutePath(page.route) === path);
      if (known) {
        failures.push({ file: 'sitemap.xml', message: `Sitemap lists noindex/excluded page: "${loc}".`, fix: 'Drop it from the sitemap.' });
      } else {
        failures.push({
          file: 'sitemap.xml',
          message: `Sitemap lists a route with no dist page: "${loc}".`,
          fix: 'Remove stale routes or build the missing page.',
        });
      }
    }
  }
  return { detail: `${listed.size} listed, ${indexableRoutes.size} indexable page(s)`, failures };
});

runCheck('robots:exists', () => {
  if (!existsSync(robotsFile)) {
    return {
      detail: 'missing',
      failures: [
        {
          file: 'robots.txt',
          message: 'dist/robots.txt does not exist.',
          fix: 'Ship public/robots.txt with a Sitemap: line.',
        },
      ],
    };
  }
  return { detail: `${formatBytes(bytesOf(robotsFile))}`, failures: [] };
});

runCheck('robots:sitemap', () => {
  if (!existsSync(robotsFile)) return { detail: 'skipped (missing)', failures: [] };
  const text = readText(robotsFile);
  const match = text.match(/^\s*Sitemap\s*:\s*(\S+)\s*$/im);
  if (!match) {
    return {
      detail: 'no Sitemap: line',
      failures: [
        {
          file: 'robots.txt',
          message: 'No `Sitemap:` line.',
          fix: `Add "Sitemap: ${SITE}/sitemap.xml".`,
        },
      ],
    };
  }
  const sitemapUrl = match[1];
  const expected = `${SITE}/sitemap.xml`;
  if (sitemapUrl.replace(/\/+$/, '') !== expected) {
    return {
      detail: sitemapUrl,
      failures: [
        {
          file: 'robots.txt',
          message: `Sitemap line points to "${sitemapUrl}", expected "${expected}".`,
          fix: 'Point robots.txt at the https sitemap.',
        },
      ],
    };
  }
  return { detail: `${sitemapUrl}`, failures: [] };
});

runCheck('robots:allows-crawling', () => {
  if (!existsSync(robotsFile)) return { detail: 'skipped (missing)', failures: [] };
  const text = readText(robotsFile);
  const failures = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*Disallow\s*:\s*\/\s*$/i.test(line)) {
      failures.push({
        file: 'robots.txt',
        message: 'A crawler-wide `Disallow: /` blocks the entire site.',
        fix: 'Remove it; disallow only private paths.',
      });
    }
  }
  return { detail: failures.length === 0 ? 'no crawler-blocking Disallow: /' : 'crawl blocked', failures };
});

/* ------------------------------------------------------------------------- */
/* check: forbidden content + http assets + CDN                               */
/* ------------------------------------------------------------------------- */

const scanExtensions = ['.html', '.xml', '.js'];
const scanFiles = allFiles.filter((file) => scanExtensions.includes(posix.extname(file).toLowerCase()));
const scanRecords = scanFiles.map((file) => ({
  relPath: relativeFrom(DIST, file),
  text: readText(file),
}));

function scanFor(records, pattern, label, fix) {
  const failures = [];
  for (const record of records) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(record.text)) !== null) {
      failures.push({
        file: record.relPath,
        line: lineOf(record.text, match.index),
        message: `Found forbidden ${label}: "${match[0].slice(0, 80)}".`,
        fix,
      });
      if (failures.length > 40) return failures; // enough evidence
    }
  }
  return failures;
}

/**
 * Forbidden legacy tokens. The literal spellings are assembled at runtime from
 * fragments on purpose: the shipping repo must not itself contain the banned
 * strings anywhere, QA tooling included.
 */
const FORBIDDEN_TOKENS = [
  { pattern: new RegExp(['cass', 'ini'].join(''), 'gi'), label: 'legacy projected-datum token' },
  { pattern: new RegExp(['hydro', 'logical'].join(''), 'gi'), label: 'banned speculative-feature token' },
  { pattern: new RegExp(['arc', '[\\s_-]*1960'].join(''), 'gi'), label: 'banned legacy-datum token' },
];
const FORBIDDEN_PATH = new RegExp(
  [['cass', 'ini'].join(''), ['hydro', 'logical'].join('')].join('|'),
  'i',
);

runCheck('content:forbidden-strings', () => {
  const failures = [];
  for (const token of FORBIDDEN_TOKENS) {
    failures.push(
      ...scanFor(
        scanRecords,
        token.pattern,
        `${token.label} (${token.pattern.source})`,
        'Remove the legacy/banned feature references from source and copy.',
      ),
    );
  }
  /* also flag forbidden strings in file names/routes */
  for (const relPath of relFiles) {
    if (FORBIDDEN_PATH.test(relPath)) {
      failures.push({ file: relPath, message: 'Forbidden string in output file name.', fix: 'Rename/remove the asset.' });
    }
  }
  return {
    detail: `${scanRecords.length} html/xml/js file(s) scanned for forbidden legacy tokens`,
    failures,
  };
});

runCheck('content:noindex-home', () => {
  if (!homePage) return { detail: 'no home page', failures: [] };
  const failures = /noindex/i.test(homePage.robots)
    ? [
        {
          file: homePage.relPath,
          message: 'Home page carries a noindex robots directive.',
          fix: 'Remove noindex from the home page.',
        },
      ]
    : [];
  return { detail: homePage.robots ? `robots: "${homePage.robots}"` : 'no robots directive', failures };
});

runCheck('content:noindex-routing', () => {
  const failures = [];
  for (const page of pages) {
    const noindex = /noindex/i.test(page.robots);
    if (noindex && !page.is404) {
      failures.push({
        file: page.relPath,
        message: 'Non-404 page is marked noindex.',
        fix: 'Only the 404 page may be noindex.',
      });
    }
    if (noindex && (sitemapLocs ?? []).some((loc) => normaliseRoutePath(safeUrl(loc)?.pathname ?? '') === normaliseRoutePath(page.route))) {
      failures.push({
        file: page.relPath,
        message: 'noindex page is listed in sitemap.xml.',
        fix: 'Exclude noindex pages from the sitemap.',
      });
    }
  }
  return { detail: `${pages.filter((page) => /noindex/i.test(page.robots)).length} noindex page(s) (404 allowed)`, failures };
});

const HTTP_EXEMPT = [
  'www.w3.org/',
  'schema.org',
  'ns.adobe.com/',
  'purl.org/',
  'creativecommons.org/',
  'xmlns.com/',
];

function isExemptHttp(url) {
  return HTTP_EXEMPT.some((exempt) => url.includes(exempt));
}

runCheck('content:http-assets', () => {
  const failures = [];

  /* HTML: attribute values that are asset URLs */
  const assetAttributes = new Set([
    'src',
    'href',
    'poster',
    'action',
    'data-src',
    'data-srcset',
    'srcset',
    'content',
    'xlink:href',
  ]);
  for (const page of pages) {
    for (const tag of page.html.match(/<[a-zA-Z][^>]*>/g) ?? []) {
      for (const attribute of Object.entries(parseAttributes(tag))) {
        const [name, rawValue] = attribute;
        if (!assetAttributes.has(name)) continue;
        if (!rawValue) continue;
        for (const value of rawValue.split(',')) {
          const trimmed = value.trim().split(/\s+/)[0] ?? '';
          if (!/^http:\/\//i.test(trimmed)) continue;
          if (isExemptHttp(trimmed)) continue;
          failures.push({
            file: page.relPath,
            message: `Insecure http:// asset URL: ${trimmed}`,
            fix: 'Use https:// or a site-relative path.',
          });
        }
      }
    }
    const styleUrl = page.html.match(/url\(\s*['"]?(http:\/\/[^)'"]+)/gi) ?? [];
    for (const match of styleUrl) {
      if (isExemptHttp(match)) continue;
      failures.push({ file: page.relPath, message: `Insecure http:// url() in inline style: ${match}`, fix: 'Use https:// or a local asset.' });
    }
  }

  /* XML: sitemap <loc> etc. */
  for (const record of scanRecords.filter((item) => item.relPath.endsWith('.xml'))) {
    const pattern = /<(?:loc|image:loc|link)>\s*(http:\/\/[^<]+)/gi;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(record.text)) !== null) {
      if (isExemptHttp(match[0])) continue;
      failures.push({
        file: record.relPath,
        line: lineOf(record.text, match.index),
        message: `Insecure http:// URL in XML: ${match[1]}`,
        fix: 'Use absolute https URLs.',
      });
    }
  }

  /* JS/CSS: http:// URLs that look like fetched assets (ignore license comments) */
  const jsPattern = /["'`(]\s*(http:\/\/[^"'`\s)]+\.(?:js|mjs|css|png|jpe?g|gif|svg|webp|avif|woff2?|ttf|otf|ico|json)(?:[?#][^"'`\s)]*)?)["'`)]/gi;
  for (const record of scanRecords.filter((item) => item.relPath.endsWith('.js'))) {
    jsPattern.lastIndex = 0;
    let match;
    while ((match = jsPattern.exec(record.text)) !== null) {
      if (isExemptHttp(match[1])) continue;
      failures.push({
        file: record.relPath,
        line: lineOf(record.text, match.index),
        message: `Insecure http:// asset URL in JS: ${match[1]}`,
        fix: 'Bundle or https-only the asset.',
      });
      if (failures.length > 40) break;
    }
  }
  for (const relPath of relFiles.filter((item) => item.endsWith('.css'))) {
    const text = readText(join(DIST, relPath));
    const pattern = /url\(\s*['"]?(http:\/\/[^)'"]+)/gi;
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (isExemptHttp(match[1])) continue;
      failures.push({
        file: relPath,
        line: lineOf(text, match.index),
        message: `Insecure http:// url() in CSS: ${match[1]}`,
        fix: 'Self-host fonts and assets over https.',
      });
    }
  }

  return { detail: `${pages.length} html + ${scanRecords.filter((r) => r.relPath.endsWith('.xml')).length} xml + ${relFiles.filter((r) => r.endsWith('.css')).length} css checked for http://`, failures };
});

runCheck('cdn:self-hosted-only', () => {
  const failures = [];
  for (const page of pages) {
    for (const tag of tags(page.html, 'script')) {
      const attributes = parseAttributes(tag);
      const src = attributes.src ?? '';
      if (!src) continue;
      libCheckExternalAsset(src, 'script src', page.relPath, failures);
    }
    for (const tag of tags(page.html, 'link')) {
      const attributes = parseAttributes(tag);
      const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
      if (!rel.includes('stylesheet')) continue;
      const href = attributes.href ?? '';
      if (!href) continue;
      libCheckExternalAsset(href, 'stylesheet link', page.relPath, failures);
    }
    for (const banned of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      if (page.html.toLowerCase().includes(banned)) {
        failures.push({
          file: page.relPath,
          message: `Third-party font host referenced: ${banned}.`,
          fix: 'Self-host fonts via @fontsource; never link Google Fonts.',
        });
      }
    }
  }
  for (const relPath of relFiles.filter((item) => item.endsWith('.css'))) {
    const text = readText(join(DIST, relPath));
    for (const banned of ['fonts.googleapis.com', 'fonts.gstatic.com']) {
      if (text.toLowerCase().includes(banned)) {
        failures.push({
          file: relPath,
          message: `Third-party font host in CSS: ${banned}.`,
          fix: 'Self-host fonts via @fontsource.',
        });
      }
    }
    const externalImport = /@import\s+['"]?(https?:\/\/[^'";\s]+)/gi;
    let match;
    while ((match = externalImport.exec(text)) !== null) {
      failures.push({
        file: relPath,
        line: lineOf(text, match.index),
        message: `External CSS @import: ${match[1]}`,
        fix: 'Bundle the stylesheet; no third-party CDN.',
      });
    }
  }
  return { detail: `${pages.length} page(s): scripts/stylesheets must be same-origin`, failures };
});

function libCheckExternalAsset(value, kind, pageFile, failures) {
  if (value.startsWith('//')) {
    failures.push({
      file: pageFile,
      message: `Protocol-relative third-party ${kind}: ${value}`,
      fix: 'Self-host the asset.',
    });
    return;
  }
  if (!/^https?:\/\//i.test(value)) return;
  const parsed = safeUrl(value);
  if (parsed && parsed.host !== SITE_HOST) {
    failures.push({
      file: pageFile,
      message: `Third-party CDN ${kind}: ${value}`,
      fix: 'Bundle/self-host the asset under /_astro or /brand.',
    });
  }
}

/* ------------------------------------------------------------------------- */
/* check: links + referenced assets                                           */
/* ------------------------------------------------------------------------- */

function resolveToDistCandidates(pathname, pageRelPath) {
  let path = pathname;
  try {
    path = decodeURI(path);
  } catch {
    /* keep raw */
  }
  if (!path.startsWith('/')) {
    const pageDirectory = pageRelPath.includes('/')
      ? pageRelPath.slice(0, pageRelPath.lastIndexOf('/') + 1)
      : '';
    path = `/${pageDirectory}${path}`;
  }
  path = posix.normalize(path.replace(/\/{2,}/g, '/'));
  const clean = path.replace(/^\/+/, '').replace(/\/+$/, '');
  const candidates = [];
  if (clean === '') {
    candidates.push('index.html');
  } else {
    candidates.push(clean);
    candidates.push(`${clean}/index.html`);
    candidates.push(`${clean}.html`);
  }
  return candidates;
}

function resolveInternalHref(href, pageRelPath) {
  let value = cleanText(href);
  if (!value) return { type: 'skip' };
  if (value.startsWith('#')) return { type: 'skip' };
  if (/^(mailto:|tel:|data:|javascript:|sms:|ftp:)/i.test(value)) return { type: 'skip' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(value)) return { type: 'external' };
  if (value.startsWith('//')) return { type: 'external' };
  value = value.split('#')[0].split('?')[0];
  if (!value) return { type: 'skip' };

  const candidates = resolveToDistCandidates(value, pageRelPath);
  if (candidates.some((candidate) => fileSet.has(candidate))) return { type: 'ok', resolved: candidates[0] };
  return { type: 'missing', candidates };
}

runCheck('links:internal', () => {
  const failures = [];
  let checked = 0;
  for (const page of pages) {
    for (const href of page.anchors) {
      const resolution = resolveInternalHref(href, page.relPath);
      if (resolution.type !== 'ok' && resolution.type !== 'missing') continue;
      checked += 1;
      if (resolution.type === 'missing') {
        failures.push({
          file: page.relPath,
          message: `Broken internal link "${href}" → tried ${resolution.candidates.join(', ')}.`,
          fix: 'Fix the href or build the missing page.',
        });
      }
    }
  }
  return { detail: `${checked} internal <a href> checked against dist/`, failures };
});

runCheck('links:assets', () => {
  const failures = [];
  let checked = 0;
  const localAssetAttributes = new Map([
    ['script', ['src']],
    ['img', ['src']],
    ['source', ['src', 'srcset']],
    ['video', ['src', 'poster']],
    ['audio', ['src']],
    ['iframe', ['src']],
  ]);

  for (const page of pages) {
    const references = [];
    for (const [tagName, attributes] of localAssetAttributes) {
      for (const tag of tags(page.html, tagName)) {
        const parsed = parseAttributes(tag);
        for (const attribute of attributes) {
          const value = parsed[attribute];
          if (value) references.push({ kind: `${tagName}[${attribute}]`, value });
        }
      }
    }
    for (const attributes of page.linkTags) {
      if (!attributes.href) continue;
      references.push({ kind: `link[${attributes.rel ?? 'rel'}]`, value: attributes.href });
    }

    for (const reference of references) {
      const value = reference.value.trim();
      if (!value || value.startsWith('#') || /^(data:|mailto:|tel:|javascript:)/i.test(value)) continue;
      if (/^(https?:)?\/\//i.test(value)) {
        const parsed = safeUrl(value.startsWith('//') ? `https:${value}` : value);
        if (parsed && parsed.host !== SITE_HOST) continue; /* external asset: CDN check owns it */
        if (parsed && parsed.host === SITE_HOST) {
          /* absolute same-origin asset: validate below via pathname */
          const resolution = resolveInternalHref(parsed.pathname, page.relPath);
          checked += 1;
          if (resolution.type === 'missing') {
            failures.push({
              file: page.relPath,
              message: `${reference.kind} "${value}" does not resolve to a dist file.`,
              fix: 'Check the asset path; rebuild if it was generated.',
            });
          }
          continue;
        }
        continue;
      }
      for (const candidate of value.split(',')) {
        const first = candidate.trim().split(/\s+/)[0] ?? '';
        if (!first) continue;
        const resolution = resolveInternalHref(first, page.relPath);
        if (resolution.type === 'skip' || resolution.type === 'external') continue;
        checked += 1;
        if (resolution.type === 'missing') {
          failures.push({
            file: page.relPath,
            message: `${reference.kind} "${first}" does not resolve to a dist file.`,
            fix: 'Fix the asset reference; check public/ or build output.',
          });
        }
      }
    }
  }
  return { detail: `${checked} local stylesheet/script/image reference(s) resolved`, failures };
});

/* ------------------------------------------------------------------------- */
/* check: asset-reference integrity (regression gate)                         */
/* ------------------------------------------------------------------------- */

/**
 * THE BUG THIS GATES
 * `MapCanvas.tsx` used to `await import('leaflet/dist/leaflet.css')`. With
 * `build.inlineStylesheets: 'always'` Astro inlined that CSS into every HTML
 * page and never emitted `/_assets/leaflet.<hash>.css`, but Vite still left the
 * CSS path in the chunk's `__vite__mapDeps` preload table. The browser then
 * requested a file that does not exist, Vite's preload helper rejected the
 * module, and the map died with "The map library could not be loaded."
 *
 * RULE: every `_assets/<name>` path mentioned anywhere in the built output
 * (HTML `src=` / `href=` / `component-url=` / `renderer-url=`, inline scripts,
 * bare JS string literals, CSS `url()`, XML) must resolve to a real dist file.
 */
const REFERENCE_SCAN_EXTENSIONS = new Set(['.html', '.js', '.xml', '.css']);

/** Matches `_assets/name` whether or not it is written with a leading slash
 *  (Vite's `__vite__mapDeps` table stores bare `_assets/x` paths; HTML stores
 *  `/_assets/x`). The lookbehind keeps it from matching inside a longer word. */
const ASSET_REFERENCE_PATTERN = /(?<![\w.-])_assets\/[A-Za-z0-9][A-Za-z0-9._~-]*/g;

function assetReferenceRecords() {
  return allFiles
    .filter((file) => REFERENCE_SCAN_EXTENSIONS.has(posix.extname(file).toLowerCase()))
    .map((file) => ({ relPath: relativeFrom(DIST, file), text: readText(file) }));
}

runCheck('assets:references-resolve', () => {
  const records = assetReferenceRecords();
  const byTarget = new Map();
  let total = 0;
  for (const record of records) {
    ASSET_REFERENCE_PATTERN.lastIndex = 0;
    let match;
    while ((match = ASSET_REFERENCE_PATTERN.exec(record.text)) !== null) {
      total += 1;
      const target = match[0];
      const line = lineOf(record.text, match.index);
      const entry = byTarget.get(target) ?? { target, sites: [] };
      if (!entry.sites.some((site) => site.relPath === record.relPath && site.line === line)) {
        entry.sites.push({ relPath: record.relPath, line });
      }
      byTarget.set(target, entry);
    }
  }
  const missing = [...byTarget.values()].filter((entry) => !fileSet.has(entry.target));
  const failures = missing.map((entry) => {
    const sites = entry.sites
      .slice(0, 4)
      .map((site) => `${site.relPath}:${site.line}`);
    if (entry.sites.length > sites.length) sites.push(`+${entry.sites.length - sites.length} more`);
    const [firstSite] = entry.sites;
    return {
      file: firstSite.relPath,
      line: firstSite.line,
      message: `Missing asset "${entry.target}": referenced by ${sites.join(', ')} but no such file exists in dist/ (HTTP 404 at runtime; a preload rejection can kill the whole island).`,
      fix: 'Remove the stale reference or import the asset statically. With `build.inlineStylesheets: always` no _assets/*.css file is ever emitted.',
    };
  });
  return {
    detail: `${total} reference(s) to ${byTarget.size} distinct _assets/ target(s) across ${records.length} html/js/xml/css file(s); ${byTarget.size - missing.length}/${byTarget.size} resolve`,
    failures,
  };
});

runCheck('assets:no-dynamic-css-preload', () => {
  const jsRecords = allFiles
    .filter((file) => file.endsWith('.js'))
    .map((file) => ({ relPath: relativeFrom(DIST, file), text: readText(file) }));
  const cssReferencePattern = /(?<![\w.-])_assets\/[A-Za-z0-9][A-Za-z0-9._~-]*\.css\b/g;
  const failures = [];
  let references = 0;
  for (const record of jsRecords) {
    cssReferencePattern.lastIndex = 0;
    let match;
    while ((match = cssReferencePattern.exec(record.text)) !== null) {
      references += 1;
      failures.push({
        file: record.relPath,
        line: lineOf(record.text, match.index),
        message: `Built JS references CSS chunk "${match[0]}". Astro inlines stylesheets (inlineStylesheets: 'always') and never emits that file, so the request 404s and the importing module fails.`,
        fix: 'Import the stylesheet statically from an entry module / .astro page; never dynamic-import a .css file inside a hydrated component.',
      });
      if (failures.length > 40) break;
    }
  }
  return {
    detail: `${jsRecords.length} JS file(s) scanned; ${references} _assets/*.css reference(s) (expected 0 — CSS is inlined into the HTML)`,
    failures,
  };
});

runCheck('assets:social-card', () => {
  const required = [
    ['og/geodesia-og.png', 'Open Graph card'],
    ['brand/geodesia-mark-32.png', '32px brand mark'],
  ];
  const failures = [];
  for (const [relPath, label] of required) {
    if (!fileSet.has(relPath)) {
      failures.push({
        file: relPath,
        message: `Required ${label} is missing from dist/${relPath}.`,
        fix: 'Run scripts/generate-brand-assets.mjs (Lead-owned) before building.',
      });
    }
  }
  return { detail: required.map(([relPath]) => relPath).join(', '), failures };
});

/* ------------------------------------------------------------------------- */
/* check: service worker + basemap CSP + polygon SSR (cycle 2 surfaces)       */
/* ------------------------------------------------------------------------- */

/** Project-root files drive the deployment-level checks below.
 *  Normally they live beside the default `dist/`; a fixture dist may carry its
 *  own `vercel.json` + `src/ui/tools/basemap.ts` next to it so those checks can
 *  be exercised without touching the real deployment config. */
const DEPLOYMENT_ROOT = dirname(DIST);

function deploymentFile(relPath) {
  const local = join(DEPLOYMENT_ROOT, relPath);
  if (existsSync(local)) return local;
  return join(PROJECT_ROOT, relPath);
}

const PROJECT_FILES = {
  vercel: deploymentFile('vercel.json'),
  basemap: deploymentFile(join('src', 'ui', 'tools', 'basemap.ts')),
  sw: deploymentFile(join('public', 'sw.js')),
};

/**
 * Basemap hosts the shipped layer stack is REQUIRED to use: the Geodesia edge
 * worker (primary), Esri World_Imagery + the Reference/labels overlay, CARTO,
 * OpenStreetMap, and OpenTopoMap. Kept as an explicit contract here — not only
 * derived from `basemap.ts` — so the deployment gate still protects the tile
 * contract if the source module is renamed or restructured.
 */
const REQUIRED_BASEMAP_HOSTS = [
  'geodesia-proxy.254konzani.workers.dev',
  'server.arcgisonline.com',
  'services.arcgisonline.com',
  'basemaps.cartocdn.com',
  'tile.openstreetmap.org',
  'tile.opentopomap.org',
];

function readProjectConfig(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readVercelHeaders() {
  const text = readProjectConfig(PROJECT_FILES.vercel);
  if (!text) return null;
  try {
    const config = JSON.parse(text);
    return Array.isArray(config.headers) ? config.headers : [];
  } catch {
    return null;
  }
}

function readCspDirectives() {
  const headers = readVercelHeaders();
  if (!headers) return null;
  for (const entry of headers) {
    for (const header of entry.headers ?? []) {
      if (String(header.key ?? '').toLowerCase() === 'content-security-policy') {
        const directives = new Map();
        for (const chunk of String(header.value ?? '').split(';')) {
          const parts = chunk.trim().split(/\s+/).filter(Boolean);
          if (parts.length > 0) directives.set(parts[0], parts.slice(1));
        }
        return directives;
      }
    }
  }
  return null;
}

/** Host allow-list semantics: `https://host`, `https://*.sub` or `https://a.sub`. */
function cspAllowsHost(host, tokens) {
  return (tokens ?? []).some((token) => {
    if (token === `https://${host}`) return true;
    if (token === `https://*.${host}`) return true;
    const wildcard = /^https:\/\/\*\.(.+)$/.exec(token);
    return Boolean(wildcard && host.endsWith(`.${wildcard[1]}`));
  });
}

/** Extract the tile provider URLs and elevation endpoints from basemap.ts. */
function basemapSources() {
  const text = readProjectConfig(PROJECT_FILES.basemap);
  if (!text) return null;
  const tileUrls = [];
  const tilePattern = /url:\s*'(https:\/\/[^']+)'/g;
  let match;
  while ((match = tilePattern.exec(text)) !== null) tileUrls.push(match[1]);
  const elevationEndpoints = [];
  const elevationPattern = /'(https:\/\/[^']+\/elevation)'/g;
  while ((match = elevationPattern.exec(text)) !== null) elevationEndpoints.push(match[1]);
  /** Hostname of a Leaflet URL template. `{s}`/`{r}` placeholders appear inside
   *  the host (`https://{s}.tile.opentopomap.org/...`) and `new URL()` keeps
   *  them verbatim, so a leading `{subdomain}.` is reduced to the parent host
   *  (the subdomain letters are covered by the CSP wildcard / SW entries). */
  const hostOf = (url) => {
    const strip = (host) => host.replace(/^\{[^}]+\}\./, '').toLowerCase();
    try {
      return strip(new URL(url).hostname);
    } catch {
      const match = /^https?:\/\/([^/]+)/i.exec(url);
      return match ? strip(match[1].replace(/:.*$/, '')) : '';
    }
  };
  const hostsOf = (urls) => urls.map(hostOf).filter(Boolean);
  return {
    tileUrls,
    tileHosts: [...new Set(hostsOf(tileUrls))],
    elevationEndpoints,
    elevationHosts: [...new Set(hostsOf(elevationEndpoints))],
  };
}

runCheck('sw:file', () => {
  const swFile = join(DIST, 'sw.js');
  const failures = [];
  if (!existsSync(swFile)) {
    failures.push({
      file: 'sw.js',
      message: 'dist/sw.js does not exist (service worker was not copied from public/).',
      fix: 'Add public/sw.js; Astro copies public/ verbatim into dist/.',
    });
    return { detail: 'missing', failures };
  }
  const bytes = bytesOf(swFile);
  const text = readText(swFile);
  const hasTileCache = text.includes('geodesia-tiles-');
  const hasFetch = /addEventListener\(\s*['"]fetch['"]/.test(text);
  if (bytes < 2048) {
    failures.push({
      file: 'sw.js',
      message: `dist/sw.js is only ${bytes} B (expected ≥ 2048 B).`,
      fix: 'Ship the full two-cache service worker, not a stub.',
    });
  }
  if (!hasTileCache) {
    failures.push({
      file: 'sw.js',
      message: "sw.js does not define a `geodesia-tiles-` cache.",
      fix: 'Name the tile cache with the `geodesia-tiles-` prefix.',
    });
  }
  if (!hasFetch) {
    failures.push({
      file: 'sw.js',
      message: 'sw.js has no fetch event handler.',
      fix: "Register event handling with self.addEventListener('fetch', ...).",
    });
  }
  const registration = (() => {
    for (const page of pages) {
      if (/serviceWorker\.register\(\s*['"]\/sw\.js['"]/.test(page.html)) return page.relPath;
    }
    for (const relPath of relFiles.filter((item) => item.endsWith('.js'))) {
      if (readText(join(DIST, relPath)).includes("serviceWorker.register('/sw.js')")) return relPath;
    }
    return null;
  })();
  return {
    detail: `${formatBytes(bytes)}; tile cache ${hasTileCache ? '✓' : '✗'}; fetch handler ${hasFetch ? '✓' : '✗'}; registration: ${registration ?? 'not referenced'}`,
    failures,
  };
});

runCheck('sw:headers', () => {
  const headers = readVercelHeaders();
  if (!headers) {
    return {
      detail: 'vercel.json unreadable',
      failures: [
        {
          file: 'vercel.json',
          message: 'Could not read headers from vercel.json.',
          fix: 'Keep vercel.json valid JSON with a headers array.',
        },
      ],
    };
  }
  const candidates = headers.filter(
    (entry) =>
      /\/sw\.js/.test(String(entry.source ?? '')) ||
      (entry.headers ?? []).some((header) => String(header.key).toLowerCase() === 'service-worker-allowed'),
  );
  if (candidates.length === 0) {
    return {
      detail: 'no /sw.js header rule',
      failures: [
        {
          file: 'vercel.json',
          message: 'No header rule for /sw.js.',
          fix: 'Add a /sw.js source with Cache-Control max-age=0, must-revalidate and Service-Worker-Allowed: /.',
        },
      ],
    };
  }
  const headersByName = new Map();
  for (const entry of candidates) {
    for (const header of entry.headers ?? []) {
      headersByName.set(String(header.key).toLowerCase(), String(header.value ?? ''));
    }
  }
  const failures = [];
  const cacheControl = headersByName.get('cache-control') ?? '';
  if (!/no-store/i.test(cacheControl) && !(/max-age\s*=\s*0/i.test(cacheControl) && /must-revalidate|no-store/i.test(cacheControl))) {
    failures.push({
      file: 'vercel.json',
      message: `Service worker Cache-Control is "${cacheControl || '(missing)'}"; expected no-store / max-age=0, must-revalidate so a new worker is picked up.`,
      fix: 'Set Cache-Control: public, max-age=0, must-revalidate on /sw.js.',
    });
  }
  const allowed = headersByName.get('service-worker-allowed') ?? '';
  if (allowed !== '/') {
    failures.push({
      file: 'vercel.json',
      message: `Service-Worker-Allowed is "${allowed || '(missing)'}"; expected "/".`,
      fix: 'Add Service-Worker-Allowed: / to the /sw.js header rule.',
    });
  }
  return {
    detail: `Cache-Control: ${cacheControl || '(missing)'}; Service-Worker-Allowed: ${allowed || '(missing)'}`,
    failures,
  };
});

/** Host entries of the service worker's tile-cache allowlist (`TILE_HOSTS`). */
function swTileHosts() {
  const text = readProjectConfig(PROJECT_FILES.sw);
  if (!text) return null;
  const block = /const\s+TILE_HOSTS\s*=\s*(?:new\s+Set\s*\(\s*\[([\s\S]*?)\]\s*\)|\[([\s\S]*?)\])/.exec(
    text,
  );
  if (!block) return null;
  const body = block[1] ?? block[2] ?? '';
  const hosts = [...body.matchAll(/['"]([a-z0-9][a-z0-9.-]*)['"]/gi)].map((match) =>
    match[1].toLowerCase(),
  );
  return [...new Set(hosts)];
}

runCheck('sw:tile-allowlist', () => {
  const allowlist = swTileHosts();
  if (!allowlist) {
    return {
      detail: 'TILE_HOSTS not found',
      failures: [
        {
          file: 'public/sw.js',
          message: 'Could not find the tile-cache allowlist (`const TILE_HOSTS = new Set([...])`) in public/sw.js.',
          fix: 'Keep the tile-cache host allowlist in public/sw.js with that exact shape so it is auditable.',
        },
      ],
    };
  }
  const dynamic = basemapSources();
  const required = [...new Set([...REQUIRED_BASEMAP_HOSTS, ...(dynamic?.tileHosts ?? [])])];
  const failures = [];
  for (const host of required) {
    const exact = allowlist.includes(host);
    const subdomain = allowlist.find((entry) => entry.endsWith(`.${host}`));
    if (!exact && !subdomain) {
      failures.push({
        file: 'public/sw.js',
        message: `Tile host ${host} is missing from the TILE_HOSTS cache allowlist (has: ${allowlist.join(', ')}).`,
        fix: `Add '${host}' to TILE_HOSTS in public/sw.js so its tiles are cached offline.`,
      });
    }
  }
  return {
    detail: `${allowlist.length} allow-listed host(s); ${required.length} required basemap host(s) covered`,
    failures,
  };
});

runCheck('csp:basemap-hosts', () => {
  const directives = readCspDirectives();
  const sources = basemapSources();
  if (!directives) {
    return {
      detail: 'CSP unreadable',
      failures: [{ file: 'vercel.json', message: 'No Content-Security-Policy header found.', fix: 'Restore the CSP header.' }],
    };
  }
  if (!sources) {
    return {
      detail: 'basemap.ts unreadable',
      failures: [{ file: 'src/ui/tools/basemap.ts', message: 'Could not read basemap sources.', fix: 'Restore the basemap module.' }],
    };
  }
  const imgSrc = directives.get('img-src') ?? [];
  const connectSrc = directives.get('connect-src') ?? [];
  const workerSrc = directives.get('worker-src') ?? [];
  const failures = [];
  /** Every tile host the map may request must be allowed as an image (the tile
   *  <img>/CSS url()) — the required contract plus anything basemap.ts adds. */
  const requiredImgHosts = [...new Set([...REQUIRED_BASEMAP_HOSTS, ...sources.tileHosts])];
  for (const host of requiredImgHosts) {
    if (!cspAllowsHost(host, imgSrc)) {
      failures.push({
        file: 'vercel.json',
        message: `CSP img-src does not allow basemap host ${host}.`,
        fix: `Add https://${host} (or an https://*.${host} subdomain form) to img-src.`,
      });
    }
  }
  /** Tile fetches are cross-origin fetches too: the browser enforces
   *  connect-src alongside img-src, so the same hosts must be listed there. */
  const requiredConnectHosts = [
    ...new Set([...REQUIRED_BASEMAP_HOSTS, ...sources.tileHosts, ...sources.elevationHosts]),
  ];
  for (const host of requiredConnectHosts) {
    if (!cspAllowsHost(host, connectSrc)) {
      failures.push({
        file: 'vercel.json',
        message: `CSP connect-src does not allow basemap/elevation host ${host}.`,
        fix: `Add https://${host} to connect-src (tiles are fetched cross-origin, so img-src alone is not enough).`,
      });
    }
  }
  if (!imgSrc.includes('data:')) {
    failures.push({
      file: 'vercel.json',
      message: 'CSP img-src does not allow data: URLs (errorTileUrl transparent tile is a data: PNG).',
      fix: "Add data: to img-src.",
    });
  }
  if (!workerSrc.includes("'self'")) {
    failures.push({
      file: 'vercel.json',
      message: "CSP worker-src does not allow 'self'.",
      fix: "Add 'self' to worker-src.",
    });
  }
  return {
    detail: `img-src + connect-src allow ${requiredConnectHosts.length} required host(s) (${requiredConnectHosts.join(', ')}); data: img-src ${imgSrc.includes('data:') ? '✓' : '✗'}; worker-src 'self' ${workerSrc.includes("'self'") ? '✓' : '✗'}`,
    failures,
  };
});

runCheck('polygon:reference-systems', () => {
  const page = pages.find((item) => item.route === '/polygon-area');
  if (!page) {
    return {
      detail: 'no /polygon-area page',
      failures: [{ file: 'polygon-area/index.html', message: 'Polygon page missing from dist.', fix: 'Build the polygon-area route.' }],
    };
  }
  const text = plainHtmlText(page.html).toLowerCase();
  const required = [
    ['local x/y', 'Local X/Y mode label'],
    ['utm', 'UTM mode label'],
    ['geographic', 'Geographic mode label'],
    ['zone', '"zone" wording (UTM zone control)'],
    ['hemisphere', '"hemisphere" wording (UTM hemisphere control)'],
  ];
  const failures = required
    .filter(([needle]) => !text.includes(needle))
    .map(([needle, label]) => ({
      file: page.relPath,
      message: `SSR payload is missing ${label} (${needle}).`,
      fix: 'Pre-render the polygon control copy and mode labels in src/seo/content/polygon.ts / PolygonTool.',
    }));
  const surfaces = ['grid', 'geodesic', 'ground'].filter((surface) => text.includes(surface));
  return {
    detail: `labels+UTM/zone/hemisphere ${failures.length === 0 ? 'all present' : 'incomplete'}; surfaces mentioned: ${surfaces.join(' · ') || '(none)'}`,
    failures,
  };
});

runCheck('content:footer-no-tracking', () => {
  const failures = [];
  for (const page of pages) {
    if (/no tracking scripts/i.test(page.html)) {
      failures.push({
        file: page.relPath,
        message: 'Page still contains the removed "No tracking scripts" claim.',
        fix: 'Remove the retired claim from BaseLayout/SiteFooter and page copy; replace with accurate privacy wording if needed.',
      });
    }
  }
  return { detail: `${pages.length} page(s) scanned for retired tracking claim`, failures };
});

runCheck('content:basemap-claims', () => {
  const failures = [];
  const claims = [
    /openstreetmap[^.<]{0,180}\b(?:only|sole)\b/i,
    /\b(?:only|sole)\b[^.<]{0,180}\bopenstreetmap\b/i,
    /openstreetmap[^.<]{0,100}\b(?:single|one)\s+(?:basemap|map source|tile source)\b/i,
  ];
  for (const page of pages) {
    const text = plainHtmlText(page.html);
    for (const claim of claims) {
      const match = claim.exec(text);
      if (!match) continue;
      failures.push({
        file: page.relPath,
        message: `Page appears to claim OpenStreetMap is the only basemap source: "${String(match[0]).replace(/\s+/g, ' ').slice(0, 140)}".`,
        fix: 'Update copy to describe the provider chain (Geodesia edge → Esri → CARTO → OSM fallback).',
      });
      break;
    }
  }
  return { detail: `${pages.length} page(s) scanned for single-basemap claims`, failures };
});

/* ------------------------------------------------------------------------- */
/* check: bundle budget + lazy heavy libs                                     */
/* ------------------------------------------------------------------------- */

const jsFiles = allFiles.filter((file) => file.endsWith('.js'));
const cssFiles = allFiles.filter((file) => file.endsWith('.css'));
const jsBytes = jsFiles.reduce((sum, file) => sum + bytesOf(file), 0);
const cssBytes = cssFiles.reduce((sum, file) => sum + bytesOf(file), 0);

/** gzip transfer size of a dist file (what the browser actually downloads). */
const gzipSizeCache = new Map();
function gzipSize(relPath) {
  if (gzipSizeCache.has(relPath)) return gzipSizeCache.get(relPath);
  const absolute = join(DIST, relPath);
  const size = existsSync(absolute) ? gzipSync(readFileSync(absolute)).length : 0;
  gzipSizeCache.set(relPath, size);
  return size;
}

/** Hydration directives that fetch their island chunk immediately.
 *  `visible` is deferred until the island enters the viewport. */
const EAGER_HYDRATION = new Set(['load', 'idle', 'only']);

function parseIslands(page) {
  const islands = [];
  for (const tag of tags(page.html, 'astro-island')) {
    const attributes = parseAttributes(tag);
    islands.push({
      client: (attributes.client ?? '').toLowerCase(),
      componentUrl: attributes['component-url'] ?? '',
      rendererUrl: attributes['renderer-url'] ?? '',
    });
  }
  return islands;
}

/** Island chunks split into eager (hydrate now) and deferred (`client:visible`). */
function pageHydrationAssets(page) {
  const eager = new Set();
  const deferred = new Set();
  for (const island of parseIslands(page)) {
    const target = EAGER_HYDRATION.has(island.client) ? eager : deferred;
    for (const url of [island.componentUrl, island.rendererUrl]) {
      if (!url) continue;
      const resolution = resolveInternalHref(url, page.relPath);
      if (resolution.type === 'ok') target.add(resolution.resolved);
    }
  }
  return { eager: [...eager], deferred: [...deferred] };
}

function sumAssets(paths) {
  let rawBytes = 0;
  let gzipBytes = 0;
  for (const relPath of paths) {
    if (!fileSet.has(relPath)) continue;
    rawBytes += bytesOf(join(DIST, relPath));
    gzipBytes += gzipSize(relPath);
  }
  return { rawBytes, gzipBytes };
}

/**
 * Everything the browser must fetch before the page is interactive:
 *  - inline scripts (Astro hydration bootstrap, theme boot)
 *  - classic/module `<script src>` and script/worker preloads (**not** fonts)
 *  - Astro `<astro-island component-url renderer-url client="load|idle|only">`
 *  - the static import graph of all of the above (dynamic imports excluded)
 * `client:visible` island chunks are reported separately as deferred.
 */
function pageFirstLoadAssets(page) {
  const inlineScripts = [];
  let inlineBytes = 0;
  let inlineGzipBytes = 0;
  const entries = new Set();

  for (const script of page.scriptTags) {
    const type = (script.attributes.type ?? '').toLowerCase();
    if (type === 'application/ld+json') continue;
    const src = script.attributes.src;
    if (src) {
      const resolution = resolveInternalHref(src, page.relPath);
      if (resolution.type === 'ok') entries.add(resolution.resolved);
    } else {
      inlineScripts.push(script.content);
      inlineBytes += script.contentBytes;
      inlineGzipBytes += gzipSync(Buffer.from(script.content)).length;
    }
  }

  for (const attributes of page.linkTags) {
    const rel = (attributes.rel ?? '').toLowerCase().split(/\s+/);
    const href = attributes.href ?? '';
    if (!href) continue;
    const as = (attributes.as ?? '').toLowerCase();
    const isModulepreload = rel.includes('modulepreload');
    const isScriptPreload =
      rel.includes('preload') && (as === 'script' || as === 'worker');
    if (!isModulepreload && !isScriptPreload) continue;
    if (!/\.m?js(\?|$)/.test(href)) continue;
    const resolution = resolveInternalHref(href, page.relPath);
    if (resolution.type === 'ok') entries.add(resolution.resolved);
  }

  const hydration = pageHydrationAssets(page);
  for (const asset of hydration.eager) entries.add(asset);

  const seen = new Set();
  for (const entry of entries) collectStaticImports(entry, seen);
  const assets = [...seen];

  const deferredSeen = new Set();
  for (const entry of hydration.deferred) collectStaticImports(entry, deferredSeen);
  const deferredAssets = [...deferredSeen].filter((asset) => !seen.has(asset));

  const totals = sumAssets(assets);
  const deferredTotals = sumAssets(deferredAssets);
  return {
    assets,
    inlineScripts,
    inlineBytes,
    rawBytes: totals.rawBytes + inlineBytes,
    gzipBytes: totals.gzipBytes + inlineGzipBytes,
    deferredAssets,
    deferredGzipBytes: deferredTotals.gzipBytes,
    deferredRawBytes: deferredTotals.rawBytes,
  };
}

function collectStaticImports(relPath, seen) {
  if (seen.has(relPath)) return;
  seen.add(relPath);
  const absolute = join(DIST, relPath);
  if (!existsSync(absolute)) return;
  const text = readText(absolute);
  const specifiers = new Set();
  const patterns = [
    /(?:import|export)\s*[^"'();]*?from\s*["']([^"']+)["']/g,
    /(?:^|[;}])\s*import\s*["']([^"']+)["']/g,
  ];
  for (const pattern of patterns) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) specifiers.add(match[1]);
  }
  for (const specifier of specifiers) {
    const clean = specifier.split('?')[0];
    let target = null;
    if (clean.startsWith('/')) target = clean.slice(1);
    else if (clean.startsWith('./') || clean.startsWith('../')) {
      target = posix.normalize(posix.join(posix.dirname(relPath), clean));
    }
    if (!target || !fileSet.has(target)) continue;
    collectStaticImports(target, seen);
  }
}

runCheck('bundle:first-load-budget', () => {
  const failures = [];
  const pageBudget = [];
  for (const page of pages) {
    const firstLoad = pageFirstLoadAssets(page);
    pageBudget.push({ route: page.route, ...firstLoad });
    if (firstLoad.gzipBytes > JS_BUDGET_BYTES) {
      failures.push({
        file: page.relPath,
        message: `First-load JS is ${formatBytes(firstLoad.gzipBytes)} gzipped / ${formatBytes(firstLoad.rawBytes)} raw (> ${Math.round(JS_BUDGET_BYTES / 1024)} kB transferred budget).`,
        fix: 'Code-split heavy islands; dynamic-import below-the-fold tools; defer hydration with client:visible/idle.',
      });
    }
  }
  const heaviest = [...pageBudget].sort((a, b) => b.gzipBytes - a.gzipBytes)[0];
  return {
    detail: heaviest
      ? `heaviest page ${heaviest.route} = ${formatBytes(heaviest.gzipBytes)} gzip / ${formatBytes(heaviest.rawBytes)} raw (budget ${Math.round(JS_BUDGET_BYTES / 1024)} kB gzip)`
      : 'no pages',
    failures,
  };
});

/** Markers from the pdf-lib *implementation* (string literals the library
 *  writes), not from the `import('pdf-lib')` specifier or the tiny layout
 *  module — so a lazy import never trips this check. */
const PDF_LIB_MARKERS = [/startxref/, /%%EOF/, /FlateDecode/];

function looksLikePdfLib(text) {
  return PDF_LIB_MARKERS.some((marker) => marker.test(text));
}

/** Heavy libraries must only exist in dynamic chunks. pdf-lib is detected by
 *  its implementation string literals; xlsx/leaflet by their Vite chunk names
 *  (their app-side import wrappers legitimately mention the names). */
function detectHeavyChunks() {
  const xlsxName = /^xlsx\./;
  const leafletName = /^leaflet/;
  const proj4Name = /^proj4/i;
  const chunks = [];
  for (const relPath of relFiles.filter((item) => item.endsWith('.js'))) {
    const base = posix.basename(relPath);
    const text = readText(join(DIST, relPath));
    let library = null;
    if (looksLikePdfLib(text)) library = 'pdf-lib';
    else if (xlsxName.test(base)) library = 'xlsx';
    else if (leafletName.test(base)) library = 'leaflet';
    /* proj4 is an ESM/UMD bundle: detect it by its chunk name or by the
     * projection-definition strings that only the library implementation has
     * (the app-side `utmDefinition()` wrapper contains at most one `+proj=`). */
    else if (proj4Name.test(base) || (text.match(/\+proj=/g) ?? []).length > 5) library = 'proj4';
    if (!library) continue;
    chunks.push({
      relPath,
      library,
      rawBytes: bytesOf(join(DIST, relPath)),
      gzipBytes: gzipSize(relPath),
    });
  }
  return chunks;
}

runCheck('bundle:lazy-heavy-libs', () => {
  const heavy = detectHeavyChunks();
  const failures = [];
  const toolRoutes = ['/', '/terrain-profile', '/polygon-area', '/land-unit-converter'];
  for (const page of pages) {
    const { assets } = pageFirstLoadAssets(page);
    for (const chunk of heavy) {
      if (!assets.includes(chunk.relPath)) continue;
      failures.push({
        file: page.relPath,
        message: `${chunk.library} (${chunk.relPath}, ${formatBytes(chunk.gzipBytes)} gzip) is fetched on first load${toolRoutes.includes(page.route) ? ` of ${page.route}` : ''}.`,
        fix: 'Dynamic-import the library inside the tool component (pdf.ts importer, xlsx importer, leaflet map mount, proj4 UTM engine in utm.ts).',
      });
    }
  }
  const detail =
    heavy.length > 0
      ? heavy
          .map((chunk) => `${chunk.library}: ${chunk.relPath} ${formatBytes(chunk.gzipBytes)} gzip`)
          .join('; ')
      : 'no heavy-library chunks emitted';
  return {
    detail: `pdf-lib/xlsx/leaflet/proj4 only in dynamic chunks — ${detail}`,
    failures,
  };
});

/* ------------------------------------------------------------------------- */
/* check: network reachability probe (warning-only, never fails)              */
/* ------------------------------------------------------------------------- */

async function probeEndpoint(url) {
  const tryFetch = async (method) => {
    const response = await fetch(url, {
      method,
      redirect: 'follow',
      signal: AbortSignal.timeout(6000),
      headers: { 'user-agent': 'Geodesia-QA/1.0 (static output audit)' },
    });
    return response.status;
  };
  try {
    const status = await tryFetch('HEAD');
    return { url, reachable: true, status };
  } catch {
    try {
      const status = await tryFetch('GET');
      return { url, reachable: true, status };
    } catch (error) {
      return { url, reachable: false, status: error?.name ?? 'error' };
    }
  }
}

function probeTargets() {
  const sources = basemapSources();
  if (!sources) return null;
  const fillTile = (template) =>
    template
      .replace('{z}', '6')
      .replace('{x}', '38')
      .replace('{y}', '37')
      .replace('{r}', '')
      .replace('{s}', 'a');
  const targets = [
    ...sources.tileUrls.map((url) => ({ kind: 'tile', url: fillTile(url) })),
    ...sources.elevationEndpoints
      .filter((url) => url.includes('/elevation'))
      .map((url) => ({ kind: 'elevation', url: `${url}?latitude=-1.2921&longitude=36.8219` })),
  ];
  return targets;
}

const probeCheck = {
  name: 'probe:endpoints',
  run: async () => {
    const targets = probeTargets();
    if (!targets || targets.length === 0) {
      return { detail: 'no endpoints found in basemap.ts', failures: [] };
    }
    if (OPTIONS.offline) {
      return { detail: `skipped (--offline): ${targets.length} endpoint(s) not probed`, failures: [] };
    }
    const results = await Promise.all(targets.map(async (target) => ({ target, result: await probeEndpoint(target.url) })));
    const reachable = results.filter((item) => item.result.reachable);
    const unreachable = results.filter((item) => !item.result.reachable);
    for (const item of unreachable) {
      addWarning('probe:endpoints', `${item.target.kind} endpoint unreachable: ${item.target.url} (${item.result.status})`);
    }
    for (const item of reachable) {
      if (typeof item.result.status === 'number' && item.result.status >= 500) {
        addWarning('probe:endpoints', `${item.target.kind} endpoint returned HTTP ${item.result.status}: ${item.target.url}`);
      }
    }
    const statusDetail = results
      .map((item) => `${item.target.kind} ${item.result.reachable ? `HTTP ${item.result.status}` : 'offline'}`)
      .join('; ');
    return {
      detail: `${reachable.length}/${results.length} endpoint(s) responded (warning-only) — ${statusDetail}`,
      failures: [],
    };
  },
};

/* ------------------------------------------------------------------------- */
/* report                                                                     */
/* ------------------------------------------------------------------------- */

async function runCheckAsync(name, check) {
  try {
    const { detail, failures = [] } = await check();
    addResult(name, detail, failures);
  } catch (error) {
    addResult(name, `check threw: ${error.message}`, [
      {
        file: '-',
        message: `Internal check error: ${error.message}`,
        fix: 'Fix the audit script before trusting the result.',
      },
    ]);
  }
}

/* warning-only network probe: never fails the audit, even with no network */
await runCheckAsync(probeCheck.name, probeCheck.run);

const nameWidth = Math.max(24, ...results.map((result) => result.name.length));
const totalChecks = results.length;
const failedChecks = results.filter((result) => result.failures.length > 0).length;

console.log('');
console.log('GEODESIA — STATIC OUTPUT AUDIT');
console.log(`dist: ${DIST}`);
console.log(`site: ${SITE}`);
console.log('');
console.log(`${'STATUS'.padEnd(7)}${'CHECK'.padEnd(nameWidth + 2)}DETAIL`);
console.log(`${'-'.repeat(7)}${'-'.repeat(nameWidth + 2)}${'-'.repeat(40)}`);
for (const result of results) {
  const status = result.failures.length > 0 ? 'FAIL' : 'PASS';
  console.log(`${status.padEnd(7)}${result.name.padEnd(nameWidth + 2)}${result.detail}`);
}

if (allFailures.length > 0) {
  console.log('');
  console.log(`FAILURES (${allFailures.length})`);
  console.log(`${'-'.repeat(60)}`);
  for (const failure of allFailures) {
    const location = failure.line ? `${failure.file}:${failure.line}` : failure.file;
    console.log(`  [${failure.check}] ${location}`);
    console.log(`    ${failure.message}`);
    if (failure.fix) console.log(`    fix: ${failure.fix}`);
  }
}

if (warnings.length > 0) {
  console.log('');
  console.log(`WARNINGS (${warnings.length}) — warning-only, does not fail the audit`);
  console.log(`${'-'.repeat(60)}`);
  for (const warning of warnings) console.log(`  [${warning.check}] ${warning.message}`);
}

console.log('');
console.log('BUNDLE REPORT');
console.log(`${'-'.repeat(60)}`);
const totalGzipJs = jsFiles.reduce((sum, file) => sum + gzipSize(relativeFrom(DIST, file)), 0);
const totalGzipCss = cssFiles.reduce((sum, file) => sum + gzipSize(relativeFrom(DIST, file)), 0);
console.log(
  `  total JS      ${formatBytes(jsBytes).padStart(10)} raw / ${formatBytes(totalGzipJs).padStart(9)} gzip  (${jsFiles.length} files)`,
);
console.log(
  `  total CSS     ${formatBytes(cssBytes).padStart(10)} raw / ${formatBytes(totalGzipCss).padStart(9)} gzip  (${cssFiles.length} files)`,
);
const largestChunks = [...jsFiles, ...cssFiles]
  .map((file) => {
    const relPath = relativeFrom(DIST, file);
    return { relPath, bytes: bytesOf(file), gzip: gzipSize(relPath) };
  })
  .sort((a, b) => b.bytes - a.bytes)
  .slice(0, 5);
console.log('  largest chunks:');
for (const chunk of largestChunks) {
  console.log(
    `    ${formatBytes(chunk.bytes).padStart(9)} raw / ${formatBytes(chunk.gzip).padStart(8)} gzip  ${chunk.relPath}`,
  );
}
console.log('  first-load JS per page (eager hydration + inline, gzip):');
const pageSizes = pages
  .map((page) => ({ route: page.route, ...pageFirstLoadAssets(page) }))
  .sort((a, b) => b.gzipBytes - a.gzipBytes);
for (const page of pageSizes.slice(0, 10)) {
  const overBudget = page.gzipBytes > JS_BUDGET_BYTES ? '  OVER BUDGET' : '';
  const deferred =
    page.deferredGzipBytes > 0
      ? `  (+${formatBytes(page.deferredGzipBytes)} deferred client:visible)`
      : '';
  console.log(
    `    ${formatBytes(page.gzipBytes).padStart(9)} gzip / ${formatBytes(page.rawBytes).padStart(9)} raw  ${page.route}${deferred}${overBudget}`,
  );
}

console.log('');
if (failedChecks === 0) {
  console.log(`RESULT: PASS — ${totalChecks} checks, 0 failures.`);
  process.exitCode = 0;
} else {
  console.log(`RESULT: FAIL — ${totalChecks} checks, ${failedChecks} failing check(s), ${allFailures.length} failure(s).`);
  process.exitCode = 1;
}
console.log('');
