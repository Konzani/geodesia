import type { AboutContent } from './types';

export const aboutContent: AboutContent = {
  eyebrow: 'About · Method and standards',
  h1: 'Method & standards',
  lede: 'Three instruments, one maths core, and a rule that every figure shown in the browser can be reproduced from the method stated beside it. This page is the standing method statement for Geodesia.',

  sections: [
    {
      heading: 'What Geodesia is, and what it is not',
      paragraphs: [
        'Geodesia is a static site of three client-side instruments for land measurement: a terrain profiler, a polygon area engine that works from UTM, local Cartesian or geographic coordinates, and a land-area unit converter. It is written for people who handle land figures professionally or academically — surveyors checking a coordinate schedule, engineers reading a route, valuers converting a title area, students working through a method — and it is deliberately small: one maths core, one export pipeline, three instruments.',
        'The instruments are built for planning, verification and coursework. They are not an adjudicated boundary survey and cannot establish the position of a boundary mark, ownership, or a cadastral boundary. Geodesia does not observe anything: it computes from coordinates you supply, and it does not transform between datums, apply a geoid model, or adjust a survey network. Where a licensed surveyor’s signed survey is required, this site is not a substitute for it.',
        'The tools are map-first, because the question usually starts on the ground. The map is the largest part of the workspace and opens on satellite imagery: Satellite is the default, Terrain and Streets are a click away in the compact switcher inside the map, and Labels can overlay place and boundary names on the imagery. At zoom 17–19 that imagery is sharp enough to see plot boundaries, field edges, tracks and buildings, which is what makes drawing a line or clicking a boundary onto it useful rather than decorative. From there each tool follows a three-step flow: say what you have, put it on the map, then read the result and export it.',
      ],
      bullets: [
        'Useful for: feasibility and layout checks, area reconciliation, conversions for deeds and schedules, coursework in coordinate geometry and geodesy.',
        'Not for: adjudication, title determination, setting out boundary marks, or any figure that must carry a surveyor’s signature.',
        'Coordinates are treated as WGS 84 UTM grid values, WGS 84 geographic positions, or local grid values; no datum transformation is attempted in any case.',
      ],
    },
    {
      heading: 'The computations we trust',
      paragraphs: [
        'The arithmetic is deliberately conventional. The area engine reports three surfaces: a grid surface from the Gaussian trapezoid, or shoelace, formula on projected metres, with the ring translated to its first vertex so large survey eastings do not cost precision; a geodesic surface from Karney’s ellipsoidal algorithms through GeographicLib on WGS 84; and a ground surface obtained by dividing the grid values by the combined scale factor. UTM projection is handled by an in-house order-6 Krüger series implementation of the WGS 84 transverse Mercator — k0 = 0.9996, false easting 500 000 m and southern false northing 10 000 000 m — and geodesic work uses the ellipsoid defined by a = 6 378 137 m and 1/f = 298.257223563, the WGS 84 defining constants rather than rounded substitutes. Land-area factors are exact definitions: 1 acre = 4840 yd² = 4046.8564224 m², 1 ft² = 0.09290304 m², 1 hectare = 10 000 m².',
        'Nothing on the site is presented as more exact than it is. The ground surface’s combined scale factor is an estimate built from the projection scale factor k = k0(1 + x²/2R²) at the parcel’s mean distance from the central meridian and an elevation factor a/(a+h); the estimate and both components are shown, a surveyed override is accepted, and the interface states which one was applied. Elevations from the elevation service are described as a digital elevation surface, not as survey levels. Where an instrument rounds, it rounds for display only: the arithmetic carries double precision throughout, and the exported report records the rounded figures with the parameters and method needed to reproduce them.',
      ],
      bullets: [
        'Grid surface: Gaussian shoelace on projected UTM metres, ring translated to its first vertex.',
        'Geodesic surface: Karney series on the WGS 84 ellipsoid via GeographicLib, independent of any grid.',
        'Ground surface: grid area divided by CSF² and grid distance by CSF, with CSF = k · EF.',
        'Projection: WGS 84 / UTM through a Krüger order-6 transverse Mercator series, k0 = 0.9996, false easting 500 000 m, southern false northing 10 000 000 m.',
        'Area units: exact definitional factors, one multiplication into square metres and out again.',
        'Terrain: geodesic chainage, separate climb and descent accumulations, percentage and degree gradients.',
      ],
    },
    {
      heading: 'Client-side execution and privacy',
      paragraphs: [
        'Every calculation runs inside the browser tab. There is no account, no server-side processing of the coordinates you enter, and no analytics or tracking script on the site. The tables, calculations and exports keep working without a connection; only new map tiles and elevation lookups need the network. Nothing you paste into the polygon instrument or the converter is uploaded anywhere.',
        'Two features do reach the network, and we would rather name them than bury them. The background map is three cached raster layers, and a compact switcher inside the map chooses between them. Satellite — the default — is high-resolution aerial imagery (Esri World Imagery), with optional place and boundary labels over it. Terrain is Thunderforest styling over OpenStreetMap data, served through the Geodesia edge tile cache, a Cloudflare Worker that keeps tiles at the edge. Streets is CARTO Voyager over OpenStreetMap data. Each layer has its own ordered fallback chain, so a provider outage moves to the next source — Esri World Topographic, OpenTopoMap and OpenStreetMap appear further down those chains — instead of leaving a blank map, and every layer is shown with its own attribution. Tiles are cached at the Geodesia edge where a layer is served through it, and every tile the map has displayed is stored again in the browser by a service worker in a bounded cache, so a return visit to the same area loads mostly from disk and sends little or no tile traffic. The basemap is cartography, not measurement evidence: the area and profile figures come from your coordinates or your file, and the map is the reference they are checked against. The terrain instrument asks the Geodesia edge elevation service for ground elevations at the coordinates it samples, falling back to Open-Meteo directly; in file mode it uses only your file and makes no elevation request. The polygon instrument computes from the coordinates you type or paste without asking any elevation service, and the converter makes no network request at all.',
      ],
    },
    {
      heading: 'Exports as an audit trail',
      paragraphs: [
        'The terrain and area instruments can each produce three artefacts, and the converter exports its ledger as a CSV built on the same conventions. The CSV is a self-describing sheet: UTF-8 with a byte-order mark, RFC 4180 quoting, and header lines that record the tool, the mode and the input parameters before the data rows; where the instrument reports a timestamp, it is written as ISO-8601 in UTC. The JSON follows one schema, geodesia.report/v1, and carries the tool, title, timestamp, engine block (datum, ellipsoid, method), parameters, results and notes, so a result can be re-derived from the file alone. The PDF is an A4 field report built in the browser with pdf-lib, mirroring the sections shown on screen.',
        'Download filenames carry the instrument slug and the generation timestamp. The exports are reproducible in the sense that matters: the same coordinates, mode and scale factor produce the same figures, and the file states which of those were used. They are generated locally and downloaded directly; no copy is retained by the site, because there is nowhere for it to be retained.',
      ],
    },
    {
      heading: 'Accuracy, rounding and reading the reports',
      paragraphs: [
        'Display precision is a policy, not a measure of accuracy. Polygon areas are shown in square metres to two decimals and in hectares and acres to four, with legs and perimeters to a millimetre, bearings to a hundredth of a degree and scale factors to eight decimals; terrain statistics follow the precision of the sampled surface, station chainage to ten metres and elevations to a tenth. The converter uses magnitude-based rounding so that a square-kilometre figure and a value below one hundredth of a unit are both readable. The exported report carries the rounded figures alongside the parameters, method and timestamp needed to reproduce them.',
        'What limits the answer is the input, not the arithmetic. A geodesic computation from coordinates is as good as the coordinates’ datum, adjustment status and precision; a grid computation is only as good as the zone, scale factor and elevation it is given; a ground-area figure inherits the uncertainty of its combined scale factor, which is why a surveyed override is offered. A terrain profile from a public elevation model is not a levelled section. Read every report with the method block first and the figures second, and quote the method alongside the number.',
      ],
    },
    {
      heading: 'The ecosystem',
      paragraphs: [
        'Geodesia is the core bench: the three instruments on this site. Two sibling applications share its stance on computation and its refusal to hide method.',
      ],
      bullets: [
        'Geodesia Core (geodesia.online) — terrain profiles, polygon area from coordinates, and land-area conversion; the instruments documented on this site.',
        'TerraFact (landiq.geodesia.online, beta; published as Land IQ) — crop suitability on browser-local Cloud-Optimized GeoTIFFs: clip a parcel against a COG raster, sample the bands and score the land against a crop profile, without uploading the imagery.',
        'MethodFlow (methodflow.geodesia.online) — research methodology diagrams composed on screen and exported as publication-grade LaTeX (TikZ), an editable Word document, or Mermaid source for an appendix.',
      ],
    },
    {
      heading: 'Contact and corrections',
      paragraphs: [
        'Corrections are welcome and are the point of a page like this. If a method statement here does not match what the code does, or a formula is misstated, a unit definition is wrong, or a report field is ambiguous, write to contact@geodesia.online with the page and the figure concerned. Method corrections take priority over cosmetic ones; where a discrepancy is real, the description is corrected rather than bent to fit the implementation.',
        'There are no accounts and no newsletter, so correspondence is read as correspondence. Geodesia makes no claim of official certification, accreditation or endorsement by any survey or lands authority, and none should be inferred from the fact that a method is conventional.',
      ],
    },
  ],
};
