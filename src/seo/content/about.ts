import type { AboutContent } from './types';

export const aboutContent: AboutContent = {
  eyebrow: 'About · Method and standards',
  h1: 'Method & standards',
  lede: 'Three instruments, one maths core, and a rule that every figure shown in the browser can be reproduced from the method stated beside it. This page is the standing method statement for Geodesia.',

  sections: [
    {
      heading: 'What Geodesia is, and what it is not',
      paragraphs: [
        'Geodesia is a static site of three client-side instruments for land measurement: a terrain profiler, a polygon area engine that works from Cartesian or geographic coordinates, and a land-area unit converter. It is written for people who handle land figures professionally or academically — surveyors checking a coordinate schedule, engineers reading a route, valuers converting a title area, students working through a method — and it is deliberately small: one maths core, one export pipeline, three instruments.',
        'The instruments are built for planning, verification and coursework. They are not an adjudicated boundary survey and cannot establish the position of a boundary mark, ownership, or a cadastral boundary. Geodesia does not observe anything: it computes from coordinates you supply, and it does not transform between datums, apply a geoid model, or adjust a survey network. Where a licensed surveyor’s signed survey is required, this site is not a substitute for it.',
      ],
      bullets: [
        'Useful for: feasibility and layout checks, area reconciliation, conversions for deeds and schedules, coursework in coordinate geometry and geodesy.',
        'Not for: adjudication, title determination, setting out boundary marks, or any figure that must carry a surveyor’s signature.',
        'Coordinates are treated as WGS 84 geographic positions or as local grid values; no datum transformation is attempted in either case.',
      ],
    },
    {
      heading: 'The computations we trust',
      paragraphs: [
        'The arithmetic is deliberately conventional. Planar polygon area uses the Gaussian trapezoid, or shoelace, formula rather than a bounding-box estimate, with the ring translated to its first vertex so that large survey eastings do not cost precision. Geodesic work — the inverse and direct problems, path sampling, polygon area and perimeter — uses Karney’s algorithms through the GeographicLib geodesic library, on the ellipsoid defined by a = 6 378 137 m and 1/f = 298.257223563, the WGS 84 defining constants rather than rounded substitutes. Land-area factors are exact definitions: 1 acre = 4840 yd² = 4046.8564224 m², 1 ft² = 0.09290304 m², 1 hectare = 10 000 m².',
        'Nothing on the site is presented as more exact than it is. The tangent-plane planar figure shown beside a geodesic area is a comparison and is labelled as one; a combined scale factor is asked of the user and never inferred from a projection; elevations from a public elevation service are described as a digital elevation surface, not as survey levels. Where an instrument rounds, it rounds for display only: the arithmetic carries double precision throughout, and the exported report records the rounded figures with the parameters and method needed to reproduce them.',
      ],
      bullets: [
        'Planar area: Gaussian shoelace sum, absolute magnitude, translated origin.',
        'Geodesic area and distance: Karney series on the WGS 84 ellipsoid via GeographicLib.',
        'Area units: exact definitional factors, one multiplication into square metres and out again.',
        'Terrain: geodesic chainage, separate climb and descent accumulations, percentage and degree gradients.',
      ],
    },
    {
      heading: 'Client-side execution and privacy',
      paragraphs: [
        'Every calculation runs inside the browser tab. There is no account, no server-side processing of the coordinates you enter, and no analytics or tracking script on the site. The tables, calculations and exports keep working without a connection; only new map tiles and elevation lookups need the network. Nothing you paste into the polygon instrument or the converter is uploaded anywhere.',
        'Two features do reach the network, and we would rather name them than bury them. The background maps are OpenStreetMap raster tiles fetched by Leaflet as you pan and zoom, so tile requests reveal the area you are viewing, as any online map does. The terrain instrument, in map mode, asks Open-Meteo for ground elevations at the coordinates it samples; in file mode it uses only your file and makes no elevation request. The polygon instrument computes from the coordinates you type or paste without any elevation service, and the converter makes no network request at all.',
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
        'Display precision is a policy, not a measure of accuracy. Areas are shown in square metres to two decimals, hectares and acres to four, square kilometres to six; leg distances to a centimetre, the closing leg to a millimetre and bearings to a tenth of a degree. The converter uses magnitude-based rounding so that a square-kilometre figure and a value below one hundredth of a unit are both readable. The exported report carries the rounded figures alongside the parameters, method and timestamp needed to reproduce them.',
        'What limits the answer is the input, not the arithmetic. A geodesic computation from coordinates is as good as the coordinates’ datum, adjustment status and precision; a planar computation is only as good as the grid and scale factor you supplied; a terrain profile from a public elevation model is not a levelled section. Read every report with the method block first and the figures second, and quote the method alongside the number.',
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
