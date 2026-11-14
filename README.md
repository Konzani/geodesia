# Geodesia

**Spatial instruments for land surveyors, computed in the browser.**
Live at **[geodesia.online](https://geodesia.online)**.

Geodesia is the hub and master landing page for a decoupled ecosystem of single-purpose
spatial applications. It hosts three client-side surveying instruments and links the
platform's micro-apps, which keep their own subdomains and release cadence:

| Application | Host | Status |
| --- | --- | --- |
| **Geodesia Core** (this repo) — terrain profile, polygon area, land units | `geodesia.online` | live |
| **TerraFact** (published as Land IQ) — crop suitability on browser-local Cloud Optimized GeoTIFFs | `landiq.geodesia.online` | beta |
| **MethodFlow** — thesis methodology diagrams → LaTeX/TikZ, Word, Mermaid | `methodflow.geodesia.online` | live |

---

## What is in this repository

A **static, pre-rendered** Astro site with three React islands. There is no backend, no
database, no account system and no server-side computation: every result is produced in
the browser tab from the numbers you enter.

### Instruments

1. **Terrain Profile** — *default view.* Elevation cross-sections from two map clicks, a
   drawn route, or an uploaded `CSV / TXT / XLSX` sheet. Returns distance, climb, descent,
   net change, min/max/mean elevation, per-station gradient, maximum gradient with the
   station it occurs at, and a slope classification — plus an interactive SVG profile,
   a station table and CSV/JSON/PDF export.
2. **Polygon Area & Coordinate Engine** — accepts local Cartesian `X, Y` (metres) and
   WGS 84 `lat, lon` in decimal or DMS. Evaluates the ring twice: verified Gaussian
   shoelace planar area and an independent geodesic area on the WGS 84 ellipsoid, with
   perimeter, closure error, centroid, per-leg distance/bearing and a full unit breakdown.
3. **Land Area Unit Converter** — one value in, every unit out: metric, imperial and the
   Kenyan cadastral/agricultural set (gunta, rood, decimal), with exact factors and a
   width × length dimension helper.

### Export pipeline

Every tool exports three artefacts, all generated client-side:

- **CSV** — UTF-8 BOM, RFC 4180 quoting, self-describing column headers with units.
- **JSON** — verification envelope under the `geodesia.report/v1` schema, carrying the
  method statement, parameters and an ISO-8601 UTC timestamp.
- **PDF** — an A4 field report typeset with [`pdf-lib`](https://pdf-lib.js.org/), with the
  Geodesia mark drawn as vector primitives, hairline rules, paginated tables and
  `Page n of m` footers.

---

## Architecture

```
src/
├─ math/        pure TypeScript geodesy — WGS 84, Gaussian shoelace, terrain statistics,
│               unit tables, RFC 4180 / XLSX ingestion. No DOM, no network.
├─ ui/
│   ├─ styles/  tokens.css (design system) · base.css · components.css · tools.css
│   ├─ components/  Astro shell (header, footer, mark, hero figure) + React primitives
│   ├─ tools/   React islands: Workspace, TerrainTool, PolygonTool, ConverterTool,
│   │           MapCanvas, ProfileChart
│   └─ hub/     HubFilter — the ecosystem app directory
├─ exports/     CSV / JSON / PDF (pdf-lib) generators
├─ seo/         site.ts (metadata source of truth), schema.ts (JSON-LD), content/*
├─ layouts/     BaseLayout (head, fonts, JSON-LD), ToolPage (data-driven SEO template)
└─ pages/       index, terrain-profile, polygon-area, land-unit-converter, about, 404
public/         brand SVGs + raster icons, Open Graph card, robots.txt, manifest
scripts/        brand asset generator, static output QA harness
LICENSE         proprietary licence
THIRD-PARTY-NOTICES.md  bundled licences and data attributions
```

**Stack:** Astro 7 (static output) · React 19 islands · TypeScript strict · Leaflet (lazy) ·
GeographicLib geodesics · pdf-lib · SheetJS · self-hosted IBM Plex.

### Why static pre-rendering

Search crawlers receive finished HTML — headings, engineering prose, formula documentation,
feature breakdowns and JSON-LD — without executing JavaScript. The instruments hydrate
afterwards. Every route ships one inlined stylesheet, three preloaded WOFF2 faces, zero
third-party scripts and no render-blocking external requests.

### SEO layer

- Semantic `<h1>`/`<h2>` structure with one `<h1>` per page and descriptive copy in the
  initial payload.
- `SoftwareApplication` + `WebApplication` JSON-LD per instrument, `Organization`,
  `WebSite`, `ItemList`, `BreadcrumbList`, `TechArticle` and `FAQPage` nodes in a single
  `@graph`.
- Per-page canonical URLs, unique keyword-led titles and descriptions, Open Graph +
  Twitter card with a generated 1200×630 preview.
- `sitemap.xml` generated at build time from the same route table the navigation uses
  (`src/pages/sitemap.xml.ts`), a hand-written `robots.txt` referencing it,
  `site.webmanifest`, and favicons derived from the channel mark.

---

## Brand

The identity is built for spatial engineers, not for a SaaS pitch deck.

| Token | Value | Role |
| --- | --- | --- |
| Ink | `#0E1413` | Basalt black with a green-grey cast — text, mark tile |
| Paper | `#F6F3EC` | Warm survey stock — page ground |
| Signal | `#C0451E` | Vermilion, the only loud colour — actions, station dot |
| Verdigris | `#2E6F68` | Oxidised copper — data series, links |
| Ochre | `#B47B1A` | Contour/elevation accent |

Type: **IBM Plex Sans** (UI) and **IBM Plex Mono** (every figure, coordinate and label),
self-hosted WOFF2, latin subset.

**The channel mark** (`public/brand/geodesia-mark.svg`) is the cartographic symbol for a
triangulation station — a triangle with a station dot — set on a basalt tile over a hairline
graticule. It is drawn on a 48-unit grid, uses two colours, and stays legible at 16 px.
It appears inline in the header, in the footer, as the favicon, in the app manifest and in
the generated Open Graph card.

---

## Local development

```bash
npm install
npm run dev          # http://localhost:4321
npm run build        # static site → dist/
npm run preview      # serve the built output
npm run test:math    # vitest — geodetic, shoelace, terrain and parser tests
npm run brand        # regenerate icons + Open Graph card (needs sharp)
node scripts/check-output.mjs   # static SEO / link / bundle audit of dist/
```

Node **≥ 22.23.4** is required (Astro 7 and Vite). A `.nvmrc` is included, and
`package.json` declares the engine so Vercel selects a supported runtime.

---

## Deploy: GitHub → Vercel

```bash
# 1. from this directory, initialise the repository
git init -b main
git add -A
git commit -m "feat: Geodesia — client-side surveying instruments, ecosystem hub and SEO layer"

# 2. create the GitHub repository, then wire the remote
#    (repo name: geodesia — the flagship hub for geodesia.online)
git remote add origin https://github.com/<your-github-username>/geodesia.git
git push -u origin main
```

Then on Vercel:

1. **Add New → Project → Import** the `geodesia` repository.
2. Framework preset is detected as **Astro**; build command `npm run build`, output
   directory `dist`. Leave the rest at defaults — `vercel.json` already sets `cleanUrls`,
   `trailingSlash: false`, immutable asset caching and the security headers.
3. **Settings → Domains** → add `geodesia.online` and `www.geodesia.online`; set the apex as
   the primary redirect target and point DNS at Vercel (`A 76.76.21.21` for the apex, or the
   `CNAME` Vercel shows for `www`).
4. Point the ecosystem subdomains (`landiq.`, `methodflow.`) at their own Vercel projects —
   they are separate deployments, deliberately decoupled from this one.

No environment variables are required. The build is fully static and reproducible from a
clean clone.

---

## Accuracy, limits and honesty

Geodesic calculations use WGS 84 with `a = 6 378 137 m` and `1/f = 298.257223563`.
Planar calculations treat `X, Y` as a grid in metres with no implied projection. Map-mode
elevations are sampled from a global bare-earth elevation surface and are *not* survey
accuracy; for design work, upload your own reduced levels. Geodesia is a planning,
verification and coursework instrument — it is not a substitute for a licensed surveyor's
adjudicated boundary survey.

## Licence and attribution

**Proprietary — all rights reserved.** See [LICENSE](LICENSE). The source, brand system and
method statements are published for review and deployment by the rights holder only.

Bundled open-source components and the required data attributions (Astro, React, Leaflet,
pdf-lib, SheetJS, GeographicLib, IBM Plex, OpenStreetMap, Open-Meteo) are itemised in
[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md). Map tiles © OpenStreetMap contributors;
elevation samples courtesy of the Open-Meteo elevation API; geodesic series by GeographicLib
(Karney).
