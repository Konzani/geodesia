import type { ToolPageContent } from './types';

export const polygonContent: ToolPageContent = {
  slug: 'polygon-area',
  eyebrow: 'Instrument 02 · Area',
  h1: 'Parcel area from coordinates, computed and checked',
  lede:
    'Paste a boundary schedule or click the corners on the map: Geodesia closes the ring, evaluates it as a planar polygon and — with geographic coordinates — again as a geodesic polygon on the WGS 84 ellipsoid, reporting every leg, the closing leg and the centroid beside the areas.',

  intro: [
    'Geodesia computes the area of a closed ring of coordinates rather than fitting a rectangle over it. Each vertex is treated as a station: the ring is joined in the order you supply, closed from the last vertex back to the first, and evaluated with the Gaussian shoelace formula for a planar area and perimeter. When the coordinates are geographic the ring is evaluated a second time, independently, as a geodesic polygon on the WGS 84 ellipsoid using Karney’s algorithms. The per-leg table gives the distance and bearing of every side, so the total area is never the only evidence you have.',
    'Two coordinate bases are supported because a parcel reaches a surveyor in two different forms. A local Cartesian list of X and Y pairs in metres is already on a grid: the shoelace result is the area on that grid, and the datum is whatever your grid implies — Geodesia adds none. WGS 84 latitude and longitude, in decimal degrees or degrees-minutes-seconds, describe positions on the ellipsoid, where the geodesic area is the one to quote. The mode switch changes the computation itself rather than only the labels: it reinterprets the rows you have entered and does not transform coordinates between the two bases.',
    'With geographic coordinates the instrument deliberately keeps the planar figure as well, computed on a tangent plane pinned to the first vertex. The two areas do not agree exactly, and that disagreement is diagnostic rather than embarrassing: the tangent plane applies a single scale, while the ellipsoid’s scale changes with latitude and direction, so the gap grows with the size of the parcel and its distance from the first vertex. Read both areas with the closing leg and the per-leg bearings, and a transposed digit, a missing corner or a ring entered out of order usually shows itself before the figure reaches a report.',
  ],

  features: [
    {
      title: 'Map and vertex table in step',
      text: 'Click the map in ring order to append vertices, or type and paste them into the table; editing, reordering or deleting a row redraws the ring immediately, and the ring on screen is the ring being computed. In local X/Y mode the geometry appears on a plain graticule sketch because bare metres have no position on a basemap, and if map tiles fail to load the table and every result remain available.',
    },
    {
      title: 'Decimal degrees or degrees-minutes-seconds',
      text: 'Latitude and longitude are read as decimal degrees or DMS — 1°23′45.6″S, 1 23 45.6 S and 36°49′18.8″E all parse, including the typographic prime characters a word processor may substitute — with the hemisphere letter leading or trailing, or a sign used instead. Degrees must be whole numbers once minutes are present, minutes and seconds must each fall in the range from zero to just under sixty, and latitude and longitude are range-checked against ±90° and ±180°.',
    },
    {
      title: 'Per-leg distance and bearing',
      text: 'Every side is tabulated with its plan distance on your coordinates, its geodesic distance on the ellipsoid and its bearing: a grid bearing measured clockwise from the positive Y axis in local mode, the forward azimuth from true north in geographic mode. The closing leg from the last vertex back to the first is a side like any other in that table.',
    },
    {
      title: 'Planar area by the Gaussian shoelace',
      text: 'The planar area is the Gaussian trapezoid, or shoelace, sum over your coordinates, taken as an absolute magnitude so winding direction does not matter; the ring is translated to its first vertex before the products accumulate, which keeps double precision intact even when survey eastings run to hundreds of thousands of metres.',
    },
    {
      title: 'Independent geodesic area on WGS 84',
      text: 'With geographic coordinates the ring is also evaluated on the WGS 84 ellipsoid through Karney’s geodesic routines in GeographicLib: each leg is a true geodesic, and the area accumulates as an ellipsoidal polygon instead of a plane projection. This figure is independent of grid, zone and scale factor, which is what a boundary defined by latitude and longitude needs.',
    },
    {
      title: 'Closure, unit breakdown and a filed record',
      text: 'The closure readout gives the length of the leg from the last entered vertex to the first to the millimetre, zero when you supply the closing duplicate yourself and the ring is explicitly closed. The authoritative area for the active mode is then converted into square metres, hectares, square kilometres, square feet, acres, roods and guntas and exported as CSV, as a JSON verification document (geodesia.report/v1), or as an A4 PDF report carrying the mode, vertex count, closing leg and UTC timestamp.',
    },
  ],

  workflow: [
    {
      title: 'Choose the coordinate basis',
      text: 'Decide whether the boundary is defined on WGS 84 or on a local grid in metres, then enter that mode. The choice settles the datum question and the area you should quote: geographic coordinates give a geodesic area on the ellipsoid, local X/Y gives an area on your grid with no ellipsoid behind it.',
    },
    {
      title: 'Enter the ring in order',
      text: 'Click each corner on the map in sequence, paste two coordinates per line — latitude then longitude, or X then Y — or add rows and type them. Order defines the ring; clockwise and counter-clockwise are both fine because the shoelace area is taken as a magnitude, but a figure entered in a scrambled order will self-cross and the per-leg bearings are the warning.',
    },
    {
      title: 'Check the ring closes as intended',
      text: 'The ring closes from the last vertex to the first without you repeating the first vertex. Read the closing leg in the area panel: on a corner list it is the final boundary side and should match the plan, while on a coordinate set whose last station is a check point it is the misclosure to compare against your adjustment.',
    },
    {
      title: 'Read both areas, then the legs',
      text: 'Compare the planar and geodesic figures and their perimeters, check the unit breakdown against the figure your client or registry expects, and scan the per-leg table for a bearing that looks wrong. If you have a combined scale factor, enter it last and read the ground area that results as a labelled, user-supplied figure.',
    },
    {
      title: 'Export with the method attached',
      text: 'The CSV holds the vertex and leg records with header lines for the mode, vertex count and both areas; the JSON is a verification document with parameters, results and notes; the PDF is a filed field report. Each carries the generation timestamp, because an area without a method and a date is not evidence.',
    },
  ],

  formulas: [
    {
      name: 'Gaussian shoelace (trapezoid) area',
      body: 'A = ½ · |Σ (xᵢ · yᵢ₊₁ − xᵢ₊₁ · yᵢ)|',
      note: 'Planar area in square metres for a ring whose last vertex is followed by the first, with i + 1 wrapping to 1. Geodesia translates the ring to its first vertex before accumulating the cross products, so the terms stay small even when the raw coordinates are large; the formula is exact in real arithmetic, but the translation is what keeps double precision clean on survey eastings. The sum is taken as an absolute value, so winding direction does not change the reported area. A self-crossing ring still returns a number from this sum, but that number is an algebraic area rather than the planimetric area of the figure you can see, which is why the sketch and the leg table are part of the check.',
    },
    {
      name: 'Geodesic polygon area on WGS 84',
      body: 'A = R_q² · Σ ε   (Karney geodesic series; R_q = authalic radius)',
      note: 'Vertices are joined by inverse geodesics on the WGS 84 ellipsoid and the ring is evaluated as an ellipsoidal polygon; Karney’s method reduces the computation to series on the auxiliary sphere and is accurate to floating-point round-off. R_q is the authalic radius — the radius of the sphere with the same surface area as the ellipsoid — derived from the defining constants a = 6 378 137 m and 1/f = 298.257223563 rather than assumed as 6 371 km. A spherical formula is not adequate at cadastral scale: a mean-radius sphere can be wrong by tens of square metres on a one-hectare parcel, and the sense of that error changes with latitude.',
    },
    {
      name: 'Leg length, bearing and the ground-area factor',
      body: 'd = √(Δx² + Δy²)   ·   θ = atan2(Δx, Δy) · 180/π, wrapped to [0°, 360°)',
      note: 'In local X/Y mode the plan distance is the Pythagorean distance between consecutive vertices and the bearing is a grid bearing measured clockwise from the positive Y axis; atan2 places the angle in the correct quadrant, and adding 360° to a negative result wraps it into the conventional circle. With geographic coordinates the same two quantities come from the inverse geodesic instead: the distance is measured on the ellipsoid and the bearing is the forward azimuth at the start of the leg. A combined scale factor supplied by you converts area to ground area as A_ground = A_base × CSF², where the base is the geodesic area in geographic mode and the planar area in local mode; the factor is never derived from a projection and every export says so.',
    },
  ],

  specs: [
    {
      label: 'Input modes',
      value: 'WGS 84 latitude/longitude as decimal degrees or DMS · local Cartesian X/Y in metres',
    },
    { label: 'Datum', value: 'WGS 84 geographic; local X/Y carries no datum and takes the grid you supply' },
    {
      label: 'Ellipsoid',
      value: 'WGS 84 · a = 6 378 137 m · 1/f = 298.257223563 · b = 6 356 752.314 245 m',
    },
    {
      label: 'Area methods',
      value: 'Gaussian shoelace trapezoid (planar) · Karney ellipsoidal polygon area (geodesic)',
    },
    {
      label: 'Outputs and area units',
      value:
        'Areas · perimeters · closing leg · centroid · per-leg distance and bearing; in m² · ha · km² · ft² · acres · roods · guntas',
    },
    {
      label: 'Exports',
      value: 'CSV · JSON geodesia.report/v1 · A4 PDF field report · ISO-8601 UTC timestamp',
    },
    {
      label: 'Rounding and limits',
      value:
        'Display rounding only (areas 0.01 m², closure 0.001 m, bearings 0.1°) · rings are never reordered or repaired · CSF is user-supplied',
    },
  ],

  faqs: [
    {
      q: 'Shoelace or geodesic — which area should I quote?',
      a: 'Quote the figure whose basis matches the coordinates. If the boundary is defined as latitude and longitude on WGS 84, quote the geodesic area: it is the area on the ellipsoid and is independent of projection, zone and scale factor. If the boundary is defined as X/Y on a local grid — a site grid, a surveyed grid, a CAD drawing in metres — quote the shoelace area, because that is the area on that grid, and state the grid and scale beside it. What you should not do is take a grid area and present it as a ground area without the scale factor that reconciles the two.',
    },
    {
      q: 'Why do the planar and geodesic areas differ?',
      a: 'In geographic mode the planar figure is computed on a tangent plane with the authalic radius, pinned to the first vertex, while the geodesic figure joins the same vertices with true geodesics on the ellipsoid. The tangent plane applies one scale in every direction, the ellipsoid does not, so the two figures diverge by a fraction of one per cent — more as the parcel grows, as it extends away from the first vertex, and as it moves to higher latitudes. That gap is a diagnostic rather than an error to average away: if it is much larger than you expect, check whether the vertices are on the datum you think they are on. In local X/Y mode there is no geodesic figure at all, because X/Y carries no datum.',
    },
    {
      q: 'Can I paste coordinates straight from Excel?',
      a: 'Yes — one vertex per line, with the two coordinates separated by a comma, tab, semicolon or spaces. Paste latitude then longitude in decimal degrees or DMS, or X then Y in metres, in the order the active mode expects. Do not paste a station-number column in front of the coordinates, because the parser reads the first two values on each line, and do not paste the header row, since a word such as Latitude cannot be read as an angle. In decimal degrees, six decimal places is roughly a decimetre on the ground and eight is roughly a millimetre, so do not add digits that the source does not support.',
    },
    {
      q: 'How is the ring closed, and what closure should I expect?',
      a: 'You never need to repeat the first vertex: Geodesia appends the closing leg from your last vertex back to your first and reports its length to the millimetre. If you do paste the first vertex again, the duplicate is dropped and the closure reads 0.000 m, which confirms the ring is explicitly closed. On a normal corner list the closing leg is simply the last boundary side, so compare it with the plan rather than with zero; on a closed traverse whose final coordinate is a check station, the same readout is the misclosure, judged against the precision of the coordinates and the traverse adjustment. No single tolerance fits a 20 m urban plot and a 200 ha farm, which is why the instrument reports the length instead of grading it.',
    },
    {
      q: 'What does the combined scale factor field do?',
      a: 'It multiplies the base area by the square of the factor you enter: A_ground = A_base × CSF², where the base is the geodesic area in geographic mode and the planar area in local mode. Geodesia does not derive the factor from a projection and will not guess whether you mean ground over grid or grid over ground; enter the convention your project control uses, check its direction against one known line, and the PDF will record the factor with a note that it is user-supplied. The field accepts factors strictly between 0.5 and 2, which covers the projection scale factors met in ordinary practice; leave it empty to keep the areas exactly as computed.',
    },
    {
      q: 'What about very large parcels, or a boundary that crosses a UTM zone?',
      a: 'The geodesic computation has no zone to cross: it works from latitude and longitude directly, so a parcel spanning a zone boundary is computed in one pass and every leg distance is ellipsoidal. The planar X/Y mode is different, because it is only meaningful on one consistent grid — if you supply coordinates from different projections, the shoelace area is a mixture and should not be quoted. For parcels measured in tens of kilometres the tangent-plane comparison also drifts, which is exactly why the geodesic figure is treated as authoritative in geographic mode.',
    },
  ],

  closing:
    'A parcel area is only as good as the coordinates behind it, so the instrument is built to expose the working: the leg table shows every distance and bearing, the closing leg shows how the ring meets itself, and the export carries the method, the mode and a UTC timestamp beside the numbers. Nothing is computed on a server, so the boundary you paste stays in the browser tab, and the CSV, JSON or PDF is a record that can be filed with the survey rather than a black-box number transcribed into one.',
};
