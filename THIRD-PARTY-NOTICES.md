# Third-party notices

Geodesia is built on open-source software and open geospatial data. This file records
what is bundled, under which licence, and what attribution is required in the shipped
product. It is documentation, not legal advice.

## Bundled libraries (installed from npm, shipped in the client bundle)

| Component | Version | Licence | How it ships | Attribution |
| --- | --- | --- | --- | --- |
| [Astro](https://astro.build) | 7.x | MIT | Static build tool (not shipped at runtime beyond island loader) | `astro` copyright © Astro contributors |
| [React / React DOM](https://react.dev) | 19.x | MIT | First-load island runtime | © Meta Platforms, Inc. and affiliates |
| [Leaflet](https://leafletjs.com) | 1.9.4 | BSD-2-Clause | Lazy chunk (map only) | © Volodymyr Agafonkin, © CloudMade |
| [pdf-lib](https://pdf-lib.js.org) | 1.17.1 | MIT | Lazy chunk (PDF export only) | © Andrew Dillon |
| [SheetJS xlsx](https://sheetjs.com) | 0.18.5 | Apache-2.0 | Lazy chunk (XLSX upload only) | © SheetJS LLC |
| [geographiclib-geodesic](https://geographiclib.sourceforge.io/) | 2.2.0 | MIT | Maths core (shipped) | © Charles F. F. Karney |
| [IBM Plex Sans / Mono](https://github.com/IBM/plex) | via @fontsource | SIL Open Font License 1.1 | Self-hosted WOFF2, latin subset | © IBM Corp. |
| [@fontsource](https://fontsource.org) | 5.x | MIT | Font packaging | © Fontsource contributors |

### Notes

- **SheetJS xlsx 0.18.5** is the last version published to the public npm registry; later
  releases are distributed by SheetJS directly. It is used only to read a spreadsheet the
  user selects, runs entirely client-side, and is loaded lazily on first XLSX upload — it is
  never part of the first-load bundle. If the SheetJS registry build is adopted later, replace
  the dependency and re-run `npm run build` plus the export tests.
- **pdf-lib** is imported dynamically inside `buildPDF`, so its ~400 kB chunk is fetched only
  when a user exports a PDF.
- **Leaflet** is imported dynamically when a map panel mounts; there is a text-only fallback
  path for every map interaction (manual coordinate entry and file upload).

## Data services and tile attribution (runtime, not bundled)

| Service | Use | Required attribution / terms |
| --- | --- | --- |
| [OpenStreetMap](https://www.openstreetmap.org/copyright) tiles | Basemap for the map panels | `© OpenStreetMap contributors` — shown in the Leaflet attribution control. Tile usage subject to the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/). |
| [Open-Meteo Elevation API](https://open-meteo.com/en/docs/elevation-api) | Sampled ground elevations in map mode | Free for non-commercial use; data derived from public DEM sources. Attribution shown in the instrument copy and the PDF report notes. |

Geodesia does not bundle or redistribute map tiles, elevation data or any other third-party
dataset — those are fetched by the browser at run time, by the user's own client.

## Geodesic algorithms

The ellipsoidal algorithms implemented by GeographicLib follow C. F. F. Karney,
*Algorithms for geodesics*, Journal of Geodesy 87(1), 43–55 (2013),
<https://doi.org/10.1007/s00190-012-0578-z>, and *Geodesics on an ellipsoid of revolution*
(arXiv:1102.1215). The published method statements in `src/seo/content/` cite these algorithms
so a reviewer can reproduce a result independently.

## Fonts

IBM Plex Sans and IBM Plex Mono are self-hosted from the `@fontsource` packages as latin-subset
WOFF2 files (98 kB total, three preloaded). They are licensed under the SIL Open Font License
1.1, which permits embedding and redistribution; the OFL notice travels with the packages in
`node_modules/@fontsource/*/LICENSE`. No Google Fonts request is made at runtime.
