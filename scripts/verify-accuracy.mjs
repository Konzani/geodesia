#!/usr/bin/env node
/**
 * GEODESIA - INDEPENDENT ACCURACY VERIFICATION (polygon engine v2)
 * ===========================================================================
 * PROVENANCE: `proj4` is a **devDependency used only by this script** as an
 * independent projection oracle. It is never imported by `src/`, is not part
 * of any browser bundle, and no projection library ships to users: the UTM
 * engine is the in-house Kruger order-6 series in `src/math/utm.ts`. If proj4
 * is absent (clean production install) the script falls back to an embedded,
 * independent Snyder series reference.
 *
 * The owner's top concern is accuracy, so this script does NOT trust the
 * engine's own tests. It imports the shipped `src/math` modules directly in
 * Node (24, built-in TypeScript type stripping + a resolve hook for the
 * extensionless internal imports) and checks them against that independent
 * reference plus hand-computed planar geometry and an ellipsoid surface
 * integral.
 *
 * node scripts/verify-accuracy.mjs
 *
 * Exit code 0 = every measured value is inside its tolerance; 1 = a failure.
 * All measured numbers are printed so they can be quoted in the release report.
 */

import { registerHooks } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/* Import the TypeScript modules under test: Node strips the types, and this
 * resolve hook maps the modules' extensionless relative imports (`./geodesy`)
 * to `./geodesy.ts`, exactly as Vite does at build time. */
registerHooks({
 resolve(specifier, context, nextResolve) {
 if (specifier.startsWith('.') && !/\.[a-zA-Z0-9]+$/.test(specifier)) {
 const candidate = new URL(`${specifier}.ts`, context.parentURL);
 if (existsSync(fileURLToPath(candidate))) {
 return { url: candidate.href, shortCircuit: true };
 }
 }
 return nextResolve(specifier, context);
 },
});

const proj4Module =
 process.env.GEODESIA_NO_PROJ4 === '1' ? null : await import('proj4').catch(() => null);
const proj4 = proj4Module?.default ?? null;
const utm = await import('../src/math/utm.ts');
const polygon = await import('../src/math/polygon.ts');

await utm.loadUtmEngine();

/* ------------------------------------------------------------------------- */
/* independent projection reference */
/* ------------------------------------------------------------------------- */
/*
 * Primary reference: proj4 (an independent projection library). It is a QA-only
 * dependency: the product itself uses a built-in Kruger series, so a clean
 * production install may drop proj4. In that case fall back to an embedded
 * Snyder transverse-Mercator series implemented here (independent of the
 * product's Kruger code) with looser - still millimetre-level - tolerances.
 */
const REFERENCE = proj4 ? `proj4 ${proj4.version ?? '2.x'}` : 'embedded Snyder series (proj4 not installed)';
const REF_METERS_TOLERANCE = proj4 ? 1e-6 : 0.05;
const REF_DEGREES_TOLERANCE = proj4 ? 1e-12 : 1e-7;

const WGS84 = { a: 6378137, f: 1 / 298.257223563 };
WGS84.e2 = WGS84.f * (2 - WGS84.f);
WGS84.ep2 = WGS84.e2 / (1 - WGS84.e2);

function snyderForward(zone, hemisphere, lon, lat) {
 const { a, e2, ep2 } = WGS84;
 const k0 = 0.9996;
 const phi = (lat * Math.PI) / 180;
 const lambda = (lon * Math.PI) / 180;
 const lambda0 = (((zone - 1) * 6 - 180 + 3) * Math.PI) / 180;
 const sinPhi = Math.sin(phi);
 const cosPhi = Math.cos(phi);
 const tanPhi = Math.tan(phi);
 const N = a / Math.sqrt(1 - e2 * sinPhi * sinPhi);
 const T = tanPhi * tanPhi;
 const C = ep2 * cosPhi * cosPhi;
 const A = cosPhi * (lambda - lambda0);
 const M =
 a *
 ((1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256) * phi -
 ((3 * e2) / 8 + (3 * e2 ** 2) / 32 + (45 * e2 ** 3) / 1024) * Math.sin(2 * phi) +
 ((15 * e2 ** 2) / 256 + (45 * e2 ** 3) / 1024) * Math.sin(4 * phi) -
 ((35 * e2 ** 3) / 3072) * Math.sin(6 * phi));
 const E =
 k0 * N * (A + ((1 - T + C) * A ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * A ** 5) / 120) +
 500000;
 let Nn =
 k0 *
 (M +
 N *
 tanPhi *
 (A ** 2 / 2 +
 ((5 - T + 9 * C + 4 * C * C) * A ** 4) / 24 +
 ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * A ** 6) / 720));
 if (hemisphere === 'S') Nn += 10000000;
 return { E, N: Nn };
}

/** Newton inversion of the embedded forward series (fallback only). */
function snyderInverse(zone, hemisphere, E, N) {
 let lat = hemisphere === 'S' ? -1 : 1;
 let lon = (zone - 1) * 6 - 180 + 3;
 for (let iteration = 0; iteration < 12; iteration += 1) {
 const forward = snyderForward(zone, hemisphere, lon, lat);
 const dE = forward.E - E;
 const dN = forward.N - N;
 if (Math.hypot(dE, dN) < 1e-9) break;
 const step = 0.01;
 const fx = snyderForward(zone, hemisphere, lon + step, lat);
 const fy = snyderForward(zone, hemisphere, lon, lat + step);
 const j11 = (fx.E - forward.E) / step;
 const j12 = (fy.E - forward.E) / step;
 const j21 = (fx.N - forward.N) / step;
 const j22 = (fy.N - forward.N) / step;
 const det = j11 * j22 - j12 * j21;
 if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break;
 lon -= (j22 * dE - j12 * dN) / det;
 lat -= (-j21 * dE + j11 * dN) / det;
 }
 return { lon, lat };
}

function referenceForward(zone, hemisphere, lon, lat) {
 if (proj4) {
 const def = `+proj=utm +zone=${zone} ${hemisphere === 'S' ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
 const [E, N] = proj4('+proj=longlat +datum=WGS84 +no_defs', def, [lon, lat]);
 return { E, N };
 }
 return snyderForward(zone, hemisphere, lon, lat);
}

function referenceInverse(zone, hemisphere, E, N) {
 if (proj4) {
 const def = `+proj=utm +zone=${zone} ${hemisphere === 'S' ? '+south ' : ''}+datum=WGS84 +units=m +no_defs`;
 const [lon, lat] = proj4(def, '+proj=longlat +datum=WGS84 +no_defs', [E, N]);
 return { lon, lat };
 }
 return snyderInverse(zone, hemisphere, E, N);
}

/* ------------------------------------------------------------------------- */
/* harness */
/* ------------------------------------------------------------------------- */

const results = [];
let failures = 0;

function record(name, measured, expected, tolerance, note = '') {
 const ok = tolerance === null ? measured === expected : Math.abs(measured - expected) <= tolerance;
 if (!ok) failures += 1;
 results.push({ name, measured, expected, tolerance, ok, note });
 return ok;
}

function fail(name, message) {
 failures += 1;
 results.push({ name, measured: message, expected: '?', tolerance: null, ok: false, note: '' });
}

const fmt = (value) =>
 typeof value === 'number'
 ? Math.abs(value) >= 1000
 ? value.toLocaleString('en-US', { maximumFractionDigits: 6 })
 : String(Number(value.toPrecision(12)))
 : String(value);

/** Independent planar shoelace area (absolute) of E,N or x,y pairs. */
function shoelace(points, getX = (p) => p.x, getY = (p) => p.y) {
 let sum = 0;
 for (let i = 0; i < points.length; i += 1) {
 const a = points[i];
 const b = points[(i + 1) % points.length];
 sum += getX(a) * getY(b) - getX(b) * getY(a);
 }
 return Math.abs(sum / 2);
}

/* ------------------------------------------------------------------------- */
/* 1. 100 m x 100 m squares */
/* ------------------------------------------------------------------------- */

const XY_SQUARE = [
 { x: 0, y: 0 },
 { x: 100, y: 0 },
 { x: 100, y: 100 },
 { x: 0, y: 100 },
];
const xySquare = await polygon.computePolygon({ mode: 'xy', points: XY_SQUARE });
record('Local X/Y 100 m square - grid area (m2)', xySquare.grid.area, 10000, 0.001);
record('Local X/Y 100 m square - perimeter (m)', xySquare.grid.perimeter, 400, 1e-9);
record(
 'Local X/Y 100 m square - independent shoelace (m2)',
 xySquare.grid.area,
 shoelace(XY_SQUARE),
 1e-9,
);

const UTM_SQUARE_N = [
 { E: 500000, N: 0 },
 { E: 500100, N: 0 },
 { E: 500100, N: 100 },
 { E: 500000, N: 100 },
];
const utmSquare = await polygon.computePolygon({
 mode: 'utm',
 points: UTM_SQUARE_N,
 zone: 37,
 hemisphere: 'N',
});
record('UTM 100 m grid square - grid area (m2)', utmSquare.grid.area, 10000, 0.001);
record('UTM 100 m grid square - perimeter (m)', utmSquare.grid.perimeter, 400, 1e-9);
record(
 'UTM 100 m grid square - independent planar shoelace (m2)',
 utmSquare.grid.area,
 shoelace(UTM_SQUARE_N, (p) => p.E, (p) => p.N),
 1e-9,
);
/* the same square in a southern-hemisphere zone, offset in both axes */
const UTM_SQUARE_S = [
 { E: 257600, N: 9857000 },
 { E: 257700, N: 9857000 },
 { E: 257700, N: 9857100 },
 { E: 257600, N: 9857100 },
];
const utmSquareS = await polygon.computePolygon({
 mode: 'utm',
 points: UTM_SQUARE_S,
 zone: 37,
 hemisphere: 'S',
});
record('UTM 37S 100 m grid square - grid area (m2)', utmSquareS.grid.area, 10000, 0.001);

/* ------------------------------------------------------------------------- */
/* 2. central meridian - false easting / false northing */
/* ------------------------------------------------------------------------- */

const cmNorth = utm.lonLatToUtm({ lat: 0, lon: 39 }, { zone: 37, hemisphere: 'N' });
const cmSouth = utm.lonLatToUtm({ lat: 0, lon: 39 }, { zone: 37, hemisphere: 'S' });
record('central meridian N - E (m)', cmNorth.E, 500000, 1e-6);
record('central meridian N - N (m)', cmNorth.N, 0, 1e-6);
record('central meridian S - E (m)', cmSouth.E, 500000, 1e-6);
record('central meridian S - N (m)', cmSouth.N, 10000000, 1e-6);
const cmNorthRef = referenceForward(37, 'N', 39, 0);
const cmSouthRef = referenceForward(37, 'S', 39, 0);
record('central meridian N - delta E vs reference (m)', Math.abs(cmNorth.E - cmNorthRef.E), 0, REF_METERS_TOLERANCE);
record('central meridian N - delta N vs reference (m)', Math.abs(cmNorth.N - cmNorthRef.N), 0, REF_METERS_TOLERANCE);
record('central meridian S - delta N vs reference (m)', Math.abs(cmSouth.N - cmSouthRef.N), 0, REF_METERS_TOLERANCE);

/* ------------------------------------------------------------------------- */
/* 3. round trip lon -> UTM -> lon, against proj4 */
/* ------------------------------------------------------------------------- */

const ROUND_TRIP = [
 { lon: 36.8219, lat: -1.2921 },
 { lon: 36.9, lat: -1.35 },
 { lon: 37.0, lat: -0.5 },
 { lon: 38.5, lat: 2.5 },
 { lon: 34.75, lat: -4.05 },
 { lon: 39.25, lat: 0.0 },
 { lon: 41.0, lat: 3.9 },
 { lon: 35.5, lat: -2.0 },
 { lon: 36.0, lat: 1.5 },
 { lon: 40.1, lat: -3.2 },
];
let maxRoundTripLon = 0;
let maxRoundTripLat = 0;
let maxForwardDelta = 0;
let maxInverseDelta = 0;
for (const point of ROUND_TRIP) {
 const params = utm.utmZoneFromLonLat(point.lon, point.lat);
 const projected = utm.lonLatToUtm(point, params);
 const back = utm.utmToLonLat(projected, params);
 maxRoundTripLon = Math.max(maxRoundTripLon, Math.abs(back.lon - point.lon));
 maxRoundTripLat = Math.max(maxRoundTripLat, Math.abs(back.lat - point.lat));

 const reference = referenceForward(params.zone, params.hemisphere, point.lon, point.lat);
 maxForwardDelta = Math.max(
 maxForwardDelta,
 Math.abs(projected.E - reference.E),
 Math.abs(projected.N - reference.N),
 );
 const inverseRef = referenceInverse(params.zone, params.hemisphere, projected.E, projected.N);
 maxInverseDelta = Math.max(
 maxInverseDelta,
 Math.abs(back.lon - inverseRef.lon),
 Math.abs(back.lat - inverseRef.lat),
 );
 /* zero-guard: the hemisphere auto-selection must agree with latitude */
 const expectedHemisphere = point.lat < 0 ? 'S' : 'N';
 if (params.hemisphere !== expectedHemisphere) fail(`auto hemisphere @${point.lon},${point.lat}`, params.hemisphere);
}
record(`round trip lon -> UTM -> lon, max error over ${ROUND_TRIP.length} points (deg)`, maxRoundTripLon, 0, 1e-9);
record(`round trip lat -> UTM -> lat, max error over ${ROUND_TRIP.length} points (deg)`, maxRoundTripLat, 0, 1e-9);
record('forward projection vs reference, max error (m)', maxForwardDelta, 0, REF_METERS_TOLERANCE);
record('inverse projection vs reference, max error (deg)', maxInverseDelta, 0, REF_DEGREES_TOLERANCE);

/** Independent ellipsoidal surface integral (no GeographicLib): the ellipsoid
 * surface element is M(phi) * N(phi) * cos(phi) d(phi) d(lambda). For an axis-aligned lat/lon parcel
 * this separates, so Simpson integration gives an independent area reference
 * that the geodesic-polygon implementation must reproduce. */
function ellipsoidIntegralArea(latSouth, latNorth, lonWest, lonEast, steps = 400) {
 const a = 6378137;
 const f = 1 / 298.257223563;
 const e2 = f * (2 - f);
 const surfaceElement = (latDeg) => {
 const phi = (latDeg * Math.PI) / 180;
 const s = Math.sin(phi);
 const w = Math.sqrt(1 - e2 * s * s);
 const meridional = (a * (1 - e2)) / w ** 3;
 const primeVertical = a / w;
 return meridional * primeVertical * Math.cos(phi);
 };
 const h = (latNorth - latSouth) / steps;
 let weighted = 0;
 for (let i = 0; i <= steps; i += 1) {
 const weight = i === 0 || i === steps ? 1 : i % 2 ? 4 : 2;
 weighted += weight * surfaceElement(latSouth + i * h);
 }
 const latIntegral = ((h * Math.PI) / 180 / 3) * weighted;
 const lonSpan = ((lonEast - lonWest) * Math.PI) / 180;
 return latIntegral * lonSpan;
}

/** Independent k and EF from the documented formulas, using proj4 centroids. */
function independentCsf(parcelGrid, meanElevationM) {
 const a = 6378137;
 const f = 1 / 298.257223563;
 const e2 = f * (2 - f);
 const k0 = 0.9996;
 const falseEasting = 500000;
 const meanE = parcelGrid.reduce((sum, point) => sum + point.E, 0) / parcelGrid.length;
 const meanN = parcelGrid.reduce((sum, point) => sum + point.N, 0) / parcelGrid.length;
 const centroid = referenceInverse(37, 'S', meanE, meanN);
 const phi = (centroid.lat * Math.PI) / 180;
 const s = Math.sin(phi);
 const w = Math.sqrt(1 - e2 * s * s);
 const meridional = (a * (1 - e2)) / w ** 3;
 const primeVertical = a / w;
 const radius = Math.sqrt(meridional * primeVertical);
 const x = meanE - falseEasting;
 const k = k0 * (1 + (x * x) / (2 * radius * radius));
 const ef = a / (a + meanElevationM);
 return { k, ef, csf: k * ef };
}

/* ------------------------------------------------------------------------- */
/* 4. real 4-point parcel, Kenya, zone 37S: grid / geodesic / ground */
/* ------------------------------------------------------------------------- */

/* ~500 m across: 0.0045 deg latitude - deg? 500.3 m; 0.0045 deg longitude at 1.29 degS - deg? 500.6 m */
const NAIROBI_PARCEL = [
 { lat: -1.2900, lon: 36.8200 },
 { lat: -1.2900, lon: 36.8245 },
 { lat: -1.2945, lon: 36.8245 },
 { lat: -1.2945, lon: 36.8200 },
];
const MEAN_ELEVATION_M = 1650;

const parcelLatLon = await polygon.computePolygon(
 { mode: 'latlon', points: NAIROBI_PARCEL },
 { ground: true, meanElevationM: MEAN_ELEVATION_M },
);

record('parcel auto zone', parcelLatLon.zone, 37, null);
record('parcel auto hemisphere', parcelLatLon.hemisphere, 'S', null);
record('parcel zone was auto-derived', parcelLatLon.zoneAuto, true, null);

const relativeDifference = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b));
const gridVsGeodesic = relativeDifference(parcelLatLon.grid.area, parcelLatLon.geodesic.area);
record('grid area vs geodesic area, relative difference (< 1 %)', gridVsGeodesic, 0, 0.01);

/* Independent reference projection + shoelace grid area from the same parcel */
const parcelGridRef = NAIROBI_PARCEL.map((point) => referenceForward(37, 'S', point.lon, point.lat));
const independentGridArea = shoelace(parcelGridRef, (p) => p.E, (p) => p.N);
record(
 'grid area vs independent reference projection + shoelace, relative difference',
 relativeDifference(parcelLatLon.grid.area, independentGridArea),
 0,
 proj4 ? 1e-9 : 1e-7,
);
let maxVertexDelta = 0;
parcelLatLon.vertices.forEach((vertex, index) => {
 if (!vertex.grid) return;
 maxVertexDelta = Math.max(
 maxVertexDelta,
 Math.abs(vertex.grid.E - parcelGridRef[index].E),
 Math.abs(vertex.grid.N - parcelGridRef[index].N),
 );
});
record('parcel vertices vs reference projection, max coordinate delta (m)', maxVertexDelta, 0, REF_METERS_TOLERANCE);

/* Independent ellipsoidal area reference: surface integral over the parcel */
const independentGeodesicArea = ellipsoidIntegralArea(-1.2945, -1.29, 36.82, 36.8245);
record(
 'geodesic area vs independent ellipsoid surface integral, relative difference',
 relativeDifference(parcelLatLon.geodesic.area, independentGeodesicArea),
 0,
 1e-8,
);

/* CSF identity: CSF = k * EF, with k and EF re-derived independently */
const independent = independentCsf(parcelGridRef, MEAN_ELEVATION_M);
record('CSF = k * EF (engine, relative)', relativeDifference(parcelLatLon.csf, parcelLatLon.projectScaleFactor * parcelLatLon.elevationFactor), 0, 1e-12);
record('projection scale factor k vs independent formula', relativeDifference(parcelLatLon.projectScaleFactor, independent.k), 0, 1e-12);
record('elevation factor EF vs independent a/(a+h)', relativeDifference(parcelLatLon.elevationFactor, independent.ef), 0, 1e-15);
record('CSF vs independent k*EF', relativeDifference(parcelLatLon.csf, independent.csf), 0, 1e-12);
const groundFromGrid = parcelLatLon.grid.area / parcelLatLon.csf ** 2;
record(
 'groundArea = gridArea / CSF^2, relative difference',
 relativeDifference(parcelLatLon.ground.area, groundFromGrid),
 0,
 1e-9,
);
record(
 'groundPerimeter = gridPerimeter / CSF, relative difference',
 relativeDifference(parcelLatLon.ground.perimeter, parcelLatLon.grid.perimeter / parcelLatLon.csf),
 0,
 1e-9,
);

/* same parcel supplied as UTM E/N (projected by proj4) must reproduce the same surfaces */
const parcelAsUtm = await polygon.computePolygon(
 { mode: 'utm', points: parcelGridRef, zone: 37, hemisphere: 'S' },
 { ground: true, meanElevationM: MEAN_ELEVATION_M },
);
record(
 'latlon vs utm input, grid area relative difference',
 relativeDifference(parcelAsUtm.grid.area, parcelLatLon.grid.area),
 0,
 1e-9,
);
record(
 'latlon vs utm input, geodesic area relative difference',
 relativeDifference(parcelAsUtm.geodesic.area, parcelLatLon.geodesic.area),
 0,
 1e-9,
);

/* explicit surveyed CSF override replaces the estimate in both surfaces */
const OVERRIDE = 1.0004;
const parcelOverride = await polygon.computePolygon(
 { mode: 'utm', points: parcelGridRef, zone: 37, hemisphere: 'S' },
 { ground: true, meanElevationM: MEAN_ELEVATION_M, combinedScaleFactor: OVERRIDE },
);
record('CSF override honoured', parcelOverride.csf, OVERRIDE, 1e-15);
record(
 'CSF override: groundArea = gridArea / override^2, relative difference',
 relativeDifference(parcelOverride.ground.area, parcelOverride.grid.area / OVERRIDE ** 2),
 0,
 1e-9,
);

/* ------------------------------------------------------------------------- */
/* 5. auto zone / hemisphere from longitude & latitude */
/* ------------------------------------------------------------------------- */

const autoNairobi = utm.utmZoneFromLonLat(36.8219, -1.2921);
record('auto zone at 36.8219 E', autoNairobi.zone, 37, null);
record('auto hemisphere at 1.2921 S', autoNairobi.hemisphere, 'S', null);
const autoNorth = utm.utmZoneFromLonLat(36.8219, 1.2921);
record('auto hemisphere at 1.2921 N', autoNorth.hemisphere, 'N', null);
record('auto zone at 33.9 E', utm.utmZoneFromLonLat(33.9, -1.0).zone, 36, null);

/* ------------------------------------------------------------------------- */
/* 6. bow-tie + duplicate validation */
/* ------------------------------------------------------------------------- */

const BOW_TIE = [
 { x: 0, y: 0 },
 { x: 100, y: 100 },
 { x: 100, y: 0 },
 { x: 0, y: 100 },
];
const bowTie = await polygon.computePolygon({ mode: 'xy', points: BOW_TIE });
record('bow-tie ring - selfIntersecting', bowTie.selfIntersecting, true, null);
record('bow-tie ring - area is finite', Number.isFinite(bowTie.grid.area), true, null, `area = ${bowTie.grid.area} m2`);
record('bow-tie ring - independent ringSelfIntersects', polygon.ringSelfIntersects(BOW_TIE), true, null);
record('bow-tie ring - area matches algebraic shoelace', bowTie.grid.area, shoelace(BOW_TIE), 1e-9);

let duplicateThrew = false;
let duplicateMessage = '';
try {
 await polygon.computePolygon({
 mode: 'xy',
 points: [
 { x: 0, y: 0 },
 { x: 0, y: 0 },
 { x: 100, y: 0 },
 { x: 0, y: 100 },
 ],
 });
} catch (error) {
 duplicateThrew = true;
 duplicateMessage = error.message;
}
record('consecutive duplicate vertices throw', duplicateThrew, true, null, duplicateMessage);

let latlonDuplicateThrew = false;
try {
 await polygon.computePolygon({
 mode: 'latlon',
 points: [
 { lat: -1.29, lon: 36.82 },
 { lat: -1.29, lon: 36.82 },
 { lat: -1.29, lon: 36.83 },
 { lat: -1.30, lon: 36.82 },
 ],
 });
} catch {
 latlonDuplicateThrew = true;
}
record('consecutive duplicate geographic vertices throw', latlonDuplicateThrew, true, null);

/* ------------------------------------------------------------------------- */
/* report */
/* ------------------------------------------------------------------------- */

const nameWidth = Math.max(48, ...results.map((result) => result.name.length));
console.log('');
console.log('GEODESIA - INDEPENDENT ACCURACY VERIFICATION (independent reference)');
console.log(`reference: ${REFERENCE}`);
console.log('');
console.log(`${'STATUS'.padEnd(7)}${'CHECK'.padEnd(nameWidth + 2)}MEASURED`);
console.log(`${'-'.repeat(7)}${'-'.repeat(nameWidth + 2)}${'-'.repeat(40)}`);
for (const result of results) {
 const status = result.ok ? 'PASS' : 'FAIL';
 const note = result.note && !result.ok ? ` (${result.note})` : '';
 console.log(`${status.padEnd(7)}${result.name.padEnd(nameWidth + 2)}${fmt(result.measured)}${note}`);
}

console.log('');
console.log('KEY FIGURES');
console.log(`${'-'.repeat(60)}`);
console.log(` UTM 100 m grid square area : ${fmt(utmSquare.grid.area)} m2`);
console.log(` central meridian 37N E / N : ${fmt(cmNorth.E)} / ${fmt(cmNorth.N)} m`);
console.log(` central meridian 37S E / N : ${fmt(cmSouth.E)} / ${fmt(cmSouth.N)} m`);
console.log(` round-trip error (lon, lat) : ${maxRoundTripLon.toExponential(3)} deg / ${maxRoundTripLat.toExponential(3)} deg`);
console.log(` forward vs reference, max delta : ${maxForwardDelta.toExponential(3)} m`);
console.log(` parcel grid area : ${fmt(parcelLatLon.grid.area)} m2`);
console.log(` parcel geodesic area : ${fmt(parcelLatLon.geodesic.area)} m2`);
console.log(` parcel ground area (h = ${MEAN_ELEVATION_M} m) : ${fmt(parcelLatLon.ground.area)} m2`);
console.log(` grid vs geodesic : ${(gridVsGeodesic * 100).toFixed(5)} %`);
console.log(` k / EF / CSF : ${fmt(parcelLatLon.projectScaleFactor)} / ${fmt(parcelLatLon.elevationFactor)} / ${fmt(parcelLatLon.csf)}`);
console.log(` independent reference grid area : ${fmt(independentGridArea)} m2`);
console.log('');

if (failures === 0) {
 console.log(`ACCURACY VERIFICATION: PASS - ${results.length} measurements inside tolerance.`);
 process.exitCode = 0;
} else {
 console.log(`ACCURACY VERIFICATION: FAIL - ${failures} of ${results.length} measurements outside tolerance.`);
 process.exitCode = 1;
}
console.log('');
