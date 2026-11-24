import type { ToolPageContent } from './types';

export const polygonContent: ToolPageContent = {
  slug: 'polygon-area',
  eyebrow: 'Instrument 02 · Area',
  h1: 'Area from UTM eastings, local X/Y or latitude and longitude',
  lede:
    'Paste the boundary in the coordinates you actually have — UTM eastings and northings with a zone and hemisphere, a local X/Y grid, or WGS 84 longitude and latitude in decimal or DMS — or draw it on the satellite map; Geodesia returns the grid, geodesic and ground surfaces, with every leg and the closure checked.',

  intro: [
    'The map is the largest part of the tool and opens on satellite imagery. Satellite is the default because plot boundaries, fences, tracks and buildings are visible on it at zoom 17–19; Terrain and Streets sit next to it in the switcher inside the map, and the Labels control adds place and boundary names over the imagery. Map tiles are cached — at the Geodesia edge where a layer is served through it, and again in your browser by a service worker — so a second visit to the same area loads quickly. In geographic mode you click the map in ring order and the longitude and latitude are written into the vertex table; in UTM and local X/Y modes the same imagery is a spatial check you can see your ring against, not a source of coordinates.',
    'The instrument accepts the three coordinate forms a parcel actually arrives in. A local X/Y list in metres is a grid with no geographic reference, so it can only give a planar grid result. UTM eastings and northings are a real projection on WGS 84: enter the zone and hemisphere, and the instrument can recover longitude and latitude from the grid, which is what makes the geodesic and ground surfaces possible. WGS 84 longitude and latitude, in decimal degrees or degrees-minutes-seconds and written longitude first, arrive without a grid at all; Geodesia projects the ring into the UTM zone of its centroid so the grid surface exists, then computes the geodesic surface directly from the geographic coordinates.',
    'Three surfaces are computed because they answer different questions. The grid surface is the Gaussian shoelace area on projected metres: it is what a UTM-based plan, GIS layer or CAD drawing sees, and it carries the distortion of the projection. The geodesic surface is Karney’s ellipsoidal area on WGS 84: it is projection-free, and it is the right figure when the boundary is defined by latitude and longitude. The ground surface divides the grid values by the combined scale factor — area by CSF², distance by CSF — and is the area on the ground at the mean elevation you enter. Local X/Y has only the first surface, because metres with an arbitrary origin cannot be related to the ellipsoid or to ground height.',
    'Which figure to quote depends on how the boundary is defined and what the figure is for. A ground area is usually the one that matches a measurement taken on the ground; a grid area is the one that reconciles with a UTM plan or GIS layer; a boundary supplied as latitude and longitude is naturally quoted as a geodesic area. In geographic mode the UTM zone is derived automatically from the ring’s centroid, and both the zone and whether it was derived are shown in the diagnostics; in UTM mode you supply the zone and hemisphere yourself. Either way one zone has to span essentially the whole parcel: near a zone edge the projection scale is at its largest and the grid area drifts from the ellipsoid by a couple of parts in a thousand, and a ring that straddles two zones cannot be projected correctly in one.',
  ],

  features: [
    {
      title: 'Satellite imagery by default',
      text: 'The map opens on high-resolution aerial imagery (Esri World Imagery): field boundaries, plot edges, fences and tracks are legible from roughly zoom 17 and sharp by 19, which is the resolution plot-level work needs. Terrain and Streets are one click away in the switcher inside the map, and Labels can be switched on to overlay place and boundary names on the imagery. Tiles are cached at the edge and in the browser, so returning to the same area is fast.',
    },
    {
      title: 'Three reference systems',
      text: 'Work in the coordinates the plan, instrument or GIS actually uses: local X/Y in metres, UTM eastings and northings with a zone from 1 to 60 and a hemisphere, or WGS 84 longitude and latitude in decimal degrees or DMS. The mode sets what is available — local X/Y gives the grid surface only, while UTM and geographic input enable the geodesic and ground surfaces.',
    },
    {
      title: 'Paste, type, drop a file or digitise on the map',
      text: 'Paste a coordinate list — one pair per line, separated by commas, tabs, spaces or semicolons — type rows into the vertex table, drop a CSV, TXT, TSV or XLSX sheet with a header row naming the coordinate columns, or in geographic mode click the map in ring order and the longitude and latitude are written into the table. Editing, reordering or deleting a row re-closes the ring; for UTM input the map is a spatial check, with the grid ring projected to longitude and latitude rather than digitised.',
    },
    {
      title: 'White coordinate sheet for projected data',
      text: 'Projected rings are drawn on a white graph-paper sheet with metre ticks and labelled axes, numbered vertices, per-leg distance labels, a north arrow, a scale bar, the centroid and an area/perimeter annotation. Metres per pixel are equal on both axes, so the plot cannot stretch the parcel the way a resized picture would.',
    },
    {
      title: 'Per-leg vector table',
      text: 'Every leg is tabulated with its grid distance, geodesic distance, ground distance, grid bearing and WGS 84 forward azimuth, including the auto-closing leg from the last vertex to the first and a totals row for each perimeter. Grid bearings are clockwise from grid north; azimuths are measured from true north on the ellipsoid.',
    },
    {
      title: 'Combined scale factor, shown not assumed',
      text: 'The ground surface reports CSF = k · EF with k = k₀(1 + x²/2R²) and EF = a/(a+h), plus the mean elevation and both components, so the correction can be checked rather than trusted. A surveyed CSF can override the estimate; the override is range-checked and labelled as user-supplied in the diagnostics, with the projection scale factor and elevation factor left visible.',
    },
    {
      title: 'Ring diagnostics and validation',
      text: 'The instrument rejects fewer than three vertices, duplicate consecutive coordinates and a simple ring whose area is zero, checks UTM eastings and northings against their plausible ranges, and warns when geographic columns look swapped so they can be flipped in one action. A self-intersecting ring is measured and flagged as a bow-tie instead of being silently repaired, and the closure leg from the last vertex to the first is reported in metres.',
    },
  ],

  workflow: [
    {
      title: 'Say how the boundary arrives',
      text: 'Choose local X/Y, UTM eastings and northings, or WGS 84 longitude and latitude, then pick the map layer that reads best: Satellite for plot boundaries, Terrain for relief, Streets for access. The map is the main working area, and in geographic mode you can click the ring straight onto the satellite imagery.',
    },
    {
      title: 'Enter or draw the ring in order',
      text: 'Paste one coordinate pair per line, type them into the table, drop a coordinate sheet (CSV/TXT/TSV/XLSX with a header row), or digitise by clicking the map in geographic mode. Geographic input is longitude then latitude, decimal or DMS; UTM input needs the zone and hemisphere set in the reference panel, and the map is only a check. The ring closes itself from the last vertex back to the first, so do not repeat the first vertex; switching reference system keeps the vertex set and flags rows that no longer parse.',
    },
    {
      title: 'Run it, read the diagnostics, then export',
      text: 'Run the computation: the grid surface is always produced, the geodesic surface is on by default for UTM and geographic input, and the ground surface appears once you switch it on and give a mean elevation. The diagnostics report the closure leg, the zone, the projection scale factor k, the elevation factor and the CSF, and warnings such as a self-intersection are printed with the result. Then export the CSV, the JSON verification document or the PDF field report, each carrying the method and a UTC timestamp.',
    },
  ],

  formulas: [
    {
      name: 'Gaussian shoelace on the projected grid',
      body: 'A_grid = ½ · |Σ(xᵢ · yᵢ₊₁ − xᵢ₊₁ · yᵢ)|',
      note: 'Planar area in square metres for the closed ring on projected coordinates — UTM eastings and northings, or a local X/Y grid. The ring is translated to its first vertex before the cross products accumulate, which keeps double precision intact when eastings run to hundreds of thousands of metres. This is the area in the plane of the projection, not on the ellipsoid: it includes the projection’s scale distortion and is the figure a UTM plan or GIS layer reports. A self-crossing ring still returns a shoelace sum, but that sum is algebraic and the result is flagged as self-intersecting rather than treated as a parcel area.',
    },
    {
      name: 'Geodesic area on the WGS 84 ellipsoid',
      body: 'A_geodesic = R_q² · Σ ε   (Karney geodesic series, WGS 84)',
      note: 'Each pair of vertices is joined by the inverse geodesic on the WGS 84 ellipsoid and the ring is evaluated as an ellipsoidal polygon; Karney’s method reduces the computation to series on the auxiliary sphere and is accurate to floating-point round-off. R_q is the authalic radius — the radius of the sphere with the same surface area as the ellipsoid — derived from a = 6 378 137 m and 1/f = 298.257223563 rather than assumed as 6 371 km. This surface has no projection scale and no zone, which is why it is the one to quote when a boundary is defined by latitude and longitude.',
    },
    {
      name: 'Combined scale factor and the ground surface',
      body: 'CSF = k · EF   ·   k = k₀(1 + x²/(2R²))   ·   EF = a/(a + h)   ·   A_ground = A_grid / CSF²',
      note: 'k is the transverse Mercator scale factor at the parcel, k₀ = 0.9996, x = meanE − 500 000 m is the mean distance of the ring from the central meridian, and R = √(M·N) at the centroid latitude, with M the meridional and N the prime-vertical radius of curvature. EF is the elevation factor: a is the ellipsoid semi-major axis and h the mean ellipsoidal height you enter. Ground distance is grid distance divided by CSF, and ground area is grid area divided by CSF². A CSF from project control replaces the estimate; the interface labels it as a user override, and the projection scale factor and elevation factor remain visible so the number can be audited.',
    },
  ],

  specs: [
    {
      label: 'Reference systems',
      value: 'Local X/Y (m) · UTM E/N with zone 1–60 and hemisphere · WGS 84 Lon, Lat decimal or DMS',
    },
    {
      label: 'Datum and ellipsoid',
      value:
        'WGS 84 · a = 6 378 137 m · 1/f = 298.257223563 · b = 6 356 752.314 245 m; local X/Y carries no datum',
    },
    {
      label: 'UTM parameters',
      value:
        'Zone 1–60 · hemisphere N/S · false easting 500 000 m · false northing 10 000 000 m (south) · k₀ = 0.9996 · Krüger order-6 transverse Mercator series',
    },
    {
      label: 'Basemap',
      value:
        'Satellite (Esri World Imagery, default) · Terrain · Streets — compact switcher inside the map, Labels overlay on the imagery, tiles cached at the edge and in the browser',
    },
    {
      label: 'Surfaces',
      value:
        'Grid (Gaussian shoelace on projected metres) · geodesic (Karney on WGS 84) · ground (grid ÷ CSF² area, grid ÷ CSF distance)',
    },
    {
      label: 'Outputs',
      value:
        'Area and perimeter per surface · per-leg grid, geodesic and ground distance with grid bearing and azimuth · centroid · closure · k, EF and CSF · hectares and acres',
    },
    {
      label: 'Exports',
      value: 'CSV · JSON geodesia.report/v1 · A4 PDF field report · ISO-8601 UTC timestamp',
    },
    {
      label: 'Rounding and limits',
      value:
        'Display rounding only (areas 0.01 m², distances 0.001 m, bearings 0.01°, scale factors 8 dp) · one zone per ring, with zone-edge distortion · self-intersection flagged, not repaired · geographic input is Lon, Lat, decimal or DMS',
    },
  ],

  faqs: [
    {
      q: 'Grid, geodesic or ground — which area do I quote?',
      a: 'Quote the surface that matches the coordinate basis and the question being asked. If the parcel is defined in UTM and the figure has to reconcile with a UTM plan, a GIS layer or a CAD drawing, the grid area is the one those systems will show. If the boundary is defined by latitude and longitude, or the parcel crosses a zone, quote the geodesic area: it is on the ellipsoid and has no projection scale. If the area is to represent the land as measured on the ground, quote the ground area, which divides the grid figure by CSF² using the distance from the central meridian and the mean elevation. The three are legitimately different, and a report should name which one it is quoting.',
    },
    {
      q: 'Why does my UTM area differ from the geodesic area?',
      a: 'The UTM grid is a projection, so every distance on it is the ellipsoidal distance multiplied by the scale factor k. At the central meridian k = 0.9996, which makes the grid area about 0.08 per cent smaller than the ellipsoidal area; 300 km from the meridian k is about 1.0007 and the grid area is about 0.14 per cent larger. The geodesic surface measures on the ellipsoid directly, so it has none of that distortion. Elevation is a separate term: at 1 000 m the elevation factor a/(a+h) is about 0.99984, which makes the ground area about 0.03 per cent larger than the ellipsoidal area before the projection is considered. That is why the instrument shows the projection scale factor and the elevation factor instead of a single unexplained correction.',
    },
    {
      q: 'How is the CSF estimated, and when should I override it?',
      a: 'The estimate combines the projection scale factor with the elevation factor. k = k₀(1 + x²/2R²) uses x, the mean easting of the ring minus the 500 000 m false easting, and R = √(M·N) at the centroid latitude; EF = a/(a+h) uses the mean ellipsoidal height you enter, which is zero if you leave the field at zero. Their product is the CSF: ground distance = grid ÷ CSF, ground area = grid ÷ CSF². Override it when project control supplies a CSF from the survey adjustment or the project specification, or when a single scale and a single elevation cannot represent the parcel. The override accepts a factor strictly between 0.5 and 2, replaces the estimate in both the results and the exports, and is labelled as user-supplied; the estimate is a working figure, not a substitute for project control.',
    },
    {
      q: 'Can I paste UTM coordinates from Google Earth or a total station?',
      a: 'Yes, in UTM mode: paste one easting/northing pair per line, in that order, and set the zone and hemisphere once in the reference panel rather than including them in the paste. Google Earth reports UTM with a zone number and a latitude band letter — use the zone number and the N or S hemisphere, not the band letter. Total station exports may be UTM or a local site grid: if the instrument used a local grid, choose Local X/Y instead, because mislabelled eastings will produce a valid-looking but wrong area. Check the datum too — the calculator assumes WGS 84, and the ranges it validates (easting 0–1 000 000 m, northing 0–10 000 000 m) will catch a northing pasted into the easting column, but not a datum mismatch.',
    },
    {
      q: 'What if my parcel crosses a UTM zone boundary?',
      a: 'A UTM ring belongs to one zone, and the instrument does not stitch zones. In geographic mode it derives a zone from the centroid and projects the whole ring into that zone, which is fine for a parcel that straddles the boundary only slightly but increasingly wrong as the ring extends into the neighbouring zone, because the projection scale grows with distance from the central meridian. For a boundary that genuinely spans two zones, quote the geodesic surface, which has no zone, or split the parcel at the boundary and compute each part in its own zone; the ground surface from a single zone is likewise an approximation for such a parcel.',
    },
    {
      q: 'How is a self-intersecting ring reported?',
      a: 'The ring is tested for crossing edges once the vertices are valid and before the surfaces are read. A crossing ring is neither rejected nor silently repaired: the result is flagged self-intersecting, a red notice explains that the boundary crosses itself in a bow-tie, and the grid, geodesic and ground figures are still displayed for diagnosis because a surveyor needs to see what was computed. The displayed area of a crossed ring is an algebraic shoelace sum, not a planimetric parcel area, so it must not be quoted; the fix is to reorder or move the crossing vertices and compute again. The plot and the leg table usually show where the order went wrong.',
    },
  ],

  closing:
    'Every figure here is a surface claim, so the instrument names the surface and shows the correction behind it: the grid figure on the projection, the geodesic figure on the ellipsoid, and the ground figure with its projection scale factor and elevation factor in view. The basemap is a reference layer — the area comes from the coordinates in the table, whether you typed them or clicked them onto the satellite imagery, and the plot shows the ring that was measured. Tiles are cached for speed, not accuracy. Nothing is computed on a server, so the coordinates you paste stay in the browser tab, and the CSV, JSON or PDF can be filed beside the survey with the method, the zone where one applies and a UTC timestamp attached.',
};
