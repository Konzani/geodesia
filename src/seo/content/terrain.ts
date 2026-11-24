import type { ToolPageContent } from './types';

export const terrainContent: ToolPageContent = {
  slug: 'terrain-profile',
  eyebrow: 'Instrument 01 · Elevation',
  h1: 'Elevation cross-sections drawn on the map or loaded from a survey sheet',
  lede:
    'The map is the main working area and opens on satellite imagery, so field boundaries, tracks and plots are visible before you draw. Trace the line you mean to build — or load the levels you already reduced — and Geodesia samples the ground along it and returns a cross-section with climb, descent, gradient and slope class, every figure traceable to a station.',

  intro: [
    'The map is the largest part of the workspace and opens on satellite imagery. Satellite is the default; Terrain and Streets sit a click away in the switcher inside the map, and the Labels control adds place and boundary names over the imagery. At zoom 17–19 the imagery is sharp enough to see plot boundaries, field edges, buildings and tracks, which is what makes drawing a line on it useful rather than decorative. Map tiles are cached — at the Geodesia edge where a layer is served through it, and again in your browser by a service worker — so a second visit to the same area loads quickly.',
    'A terrain profile is a one-dimensional reading of a two-dimensional surface. The instrument samples ground elevation at a fixed interval along your line, accumulates the horizontal distance geodesically on the WGS 84 ellipsoid, and differences consecutive elevations to separate climb from descent. The result is a cross-section you can read at a glance and a station table you can audit line by line.',
    'Drawing on the map is the quick path, and it is the one most questions need. Drag one alignment and you can see which line climbs less before a site visit. A drawn route follows the alignment of a pipeline, access track or transmission line, including its bends; a straight two-point line and a multi-vertex route are separate modes for the same sampling engine. Uploading a CSV, TXT or XLSX file is the survey path: your reduced levels are authoritative, and the instrument should not silently replace them with a public elevation surface.',
    'Distance is the part most profile tools get wrong. Sampling at a constant spacing in degrees gives station intervals that vary with latitude, and a rhumb-line chord is not the line a contractor measures. Geodesia solves the inverse geodesic problem between stations, so the cumulative chainage is the distance on the ellipsoid, and the bearing reported for each leg is the forward azimuth at that station.',
  ],

  features: [
    {
      title: 'Satellite imagery by default',
      text: 'The map opens on high-resolution aerial imagery (Esri World Imagery). Field boundaries, plots, buildings and tracks are legible from roughly zoom 17 and sharp by 19, so the line is drawn over the ground rather than over a blank grid. Terrain and Streets are one click away in the switcher inside the map, and Labels can be switched on to overlay place and boundary names on the imagery.',
    },
    {
      title: 'Draw the line on the map',
      text: 'Drag a freehand path along the alignment, or click to place vertices, and the line is drawn where you traced it. The map is the main working area with the profile, stations and exports beside it; a strict two-point line and a multi-vertex route are separate modes on the same sampling engine.',
    },
    {
      title: 'Survey sheet ingestion',
      text: 'Upload CSV, TXT or XLSX with chainage and elevation, or latitude, longitude and elevation. Columns are detected by name and confirmed in the interface before anything is computed.',
    },
    {
      title: 'Climb and descent, counted separately',
      text: 'Elevation gain is the sum of positive differences between consecutive stations, descent the sum of negative ones. Net change is start minus end, so a there-and-back route correctly reports both numbers rather than a misleading zero.',
    },
    {
      title: 'Gradient per segment, and where it peaks',
      text: 'Every station pair carries a run, rise, percent grade and angle in degrees. The maximum grade is reported with the station it occurs at, which is what decides a switchback or a culvert.',
    },
    {
      title: 'Cross-section you can interrogate',
      text: 'Hover the chart for a pinned readout at the nearest station, or step station by station with the arrow keys. The same samples feed the table, the CSV and the PDF report.',
    },
  ],

  workflow: [
    {
      title: 'Draw on the map, or upload the levels',
      text: 'The map is the main working area and opens on satellite imagery: drag the line or click vertices, switching to Terrain for contours or Streets for access roads if that reads better. If the elevations come from a survey, switch to Upload instead — reduced levels are authoritative and the instrument uses only your numbers.',
    },
    {
      title: 'Run it and read the cross-section',
      text: 'Press run and the ground is sampled along the line: climb, descent, net change, gradients and slope class appear with the chart and the station table. Read the shape first — where the summit sits, whether the descent is longer than the climb — then check individual stations against the table.',
    },
    {
      title: 'Export with the method attached',
      text: 'CSV carries the stations, JSON carries the verification envelope with parameters and timestamp, and the PDF is a field-report page with the profile chart, statistics and station table together.',
    },
  ],

  formulas: [
    {
      name: 'Chainage from the inverse geodesic',
      body: 's\u2081\u2082 = inverse geodesic (φ\u2081, λ\u2081, φ\u2082, λ\u2082)   on WGS 84',
      note: 'Consecutive stations are sampled at a fixed interval along the line; each pair is solved with the inverse geodesic problem (Karney), which also yields the forward azimuth used as the leg bearing. Chainage is the running sum of those distances, in metres.',
    },
    {
      name: 'Climb, descent and net change',
      body: '\u0394h\u1d62 = h\u1d62\u208a\u2081 \u2212 h\u1d62   \u00b7   gain = \u03a3 max(0, \u0394h)   \u00b7   descent = \u03a3 max(0, \u2212\u0394h)   \u00b7   net = h\u2099 \u2212 h\u2080',
      note: 'Differences are taken between consecutive samples after optional moving-average smoothing. Net change is the endpoint difference; because gain and descent are separate accumulations, gain \u2212 descent equals net for any profile, which is a useful self-check.',
    },
    {
      name: 'Gradient and slope classification',
      body: 'grade % = 100 \u00b7 \u0394h / \u0394s   \u00b7   angle\u00b0 = atan(\u0394h / \u0394s) \u00b7 180/\u03c0',
      note: 'Run is the geodesic distance between stations and rise the elevation difference, so grade is dimensionless and comparable between a 50 m and a 5 km section. The maximum grade over the profile identifies the classification band: flat, gentle, rolling, hilly or steep.',
    },
  ],

  specs: [
    { label: 'Input modes', value: 'Draw on map (default) · two points · route · CSV / TXT / XLSX' },
    {
      label: 'Basemap',
      value:
        'Satellite (Esri World Imagery, default) · Terrain · Streets — compact switcher inside the map, Labels overlay on the imagery',
    },
    {
      label: 'Tile caching',
      value:
        'Geodesia edge tile cache where a layer is served through it, plus a browser service-worker cache, so repeat views are fast',
    },
    { label: 'File columns', value: 'chainage + elevation, or latitude + longitude + elevation' },
    { label: 'Distance method', value: 'Inverse geodesic, WGS 84 ellipsoid' },
    { label: 'Sampling', value: 'Fixed spacing along the line, stations capped for legibility' },
    { label: 'Elevation source', value: 'Supplied in file, or sampled through the Geodesia edge elevation service (Open-Meteo fallback)' },
    { label: 'Statistics', value: 'Distance · gain · descent · net · min · max · mean · grade' },
    { label: 'Exports', value: 'CSV · JSON (geodesia.report/v1) · PDF field report' },
    { label: 'Limits', value: 'Elevation surface resolution, not vegetation or canopy height' },
  ],

  faqs: [
    {
      q: 'Where does the elevation come from, and how accurate is it?',
      a: 'In map mode the elevations come from the Geodesia edge elevation service, which returns a global digital elevation model value at each coordinate and falls back to Open-Meteo if the edge service cannot answer. That is a bare-earth surface at a horizontal resolution of tens of metres, so it will not represent a cutting, a bridge deck or a hedge, and it should not be quoted as survey accuracy. The background map is cartography, not measurement: it opens on satellite imagery (Esri World Imagery), with Terrain and Streets in the switcher inside the map and Labels optionally overlaid on the imagery, and changing the basemap has no effect on the elevations or the profile. In upload mode the elevations are yours, and the statistics are only as good as the levels in the file.',
    },
    {
      q: 'Which basemap should I use, and are the tiles cached?',
      a: 'Satellite is the default because plot boundaries, field edges, fences and tracks are visible on it at zoom 17–19, which is what most route and alignment questions need. Terrain adds shading and contours when you are judging relief; Streets is cleaner for wayfinding and access roads. Labels draws place and boundary names over the imagery and can be switched off when it clutters a plot. Tiles are cached at the Geodesia edge where a layer is served through it, and every tile the map has shown is also kept by a service worker in a bounded cache on your device, so a repeat visit to the same area loads quickly and sends little or no tile traffic. Elevation values themselves are not cached that way and still need a connection.',
    },
    {
      q: 'Why is the line on the map slightly curved?',
      a: 'Because it is a geodesic. Between two points on an ellipsoid the shortest path is not a straight line in latitude/longitude space, and over a few hundred metres the difference is invisible while over tens of kilometres it is not. Chainage follows the geodesic, so the profile and the drawn line agree with each other and with the ground.',
    },
    {
      q: 'Can I use my own levelled survey instead of the elevation service?',
      a: 'Yes, and for any real design question you should. Upload CSV, TXT or XLSX with a chainage column and an elevation column — reduced levels, spot levels or a level-book extract all work — and the instrument uses only your numbers. No elevation request is made, and the profile is exactly your survey.',
    },
    {
      q: 'How many stations are sampled, and can I change the spacing?',
      a: 'The sampling interval is fixed by the instrument so that a 200 m section and a 20 km section are both legible, and the number of stations is capped. The station table lists every sample used, so the spacing is visible in the chainage column rather than hidden. For a survey-driven profile the stations are your rows, not resampled points.',
    },
    {
      q: 'Why does elevation gain not equal the net change?',
      a: 'Because a profile that rises and falls again has both climb and descent. Net change is end minus start; gain sums every positive difference and descent sums every negative one. On an out-and-back route the net is zero while the gain and descent figures are large and both correct — which is exactly the distinction that matters for effort, drainage and vehicle performance.',
    },
    {
      q: 'Can this profile a route with bends, such as a pipeline or access track?',
      a: 'Yes — switch to route mode and add vertices instead of just two endpoints. Each leg is sampled geodesically, chainage accumulates across the vertices, and the bearing column reports the leg azimuth at each station, so the table reads like a set-out schedule rather than a single straight section.',
    },
    {
      q: 'What is the maximum line length it will handle?',
      a: 'There is no hard geographic limit; the practical constraint is the number of elevation samples requested, which is batched. For very long alignments, work section by section and export each, or upload the profile as tabular data, which bypasses sampling entirely.',
    },
  ],

  closing:
    'A profile is a claim about the ground, so the instrument is built to show its working: the station table is the evidence, the method statement is the reasoning, and the export carries both with a timestamp. The basemap is cartography — cached for speed, never the source of the numbers. If an elevation looks wrong, the sample is visible and can be corrected or replaced — which is the only defensible way for a browser tool to present terrain data.',
};
