/**
 * Geodesia — terrain profile statistics
 * ---------------------------------------------------------------------------
 * Turns an ordered, distance-cumulative elevation series into the metrics the
 * Terrain Profile instrument shows: gain, descent, net, min/max/range/mean,
 * average and maximum grade, per-segment run/rise/slope and a terrain category.
 *
 * Robustness rules
 *  - Non-finite elevations (failed elevation lookups) are treated as no-data and
 *    linearly interpolated, exactly like `noDataBelow` holes.
 *  - Gain/descent ignore floating-point noise: deltas below 1e-9 m do not
 *    contribute, so a mathematically flat series never reports phantom climb.
 *  - A segment with run = 0 reports 0 % / 0°, never Infinity or NaN.
 *
 * Pure functions only; invalid input throws an `Error` with a clear message.
 */
import type {
  SlopeSegment,
  TerrainCategory,
  TerrainOptions,
  TerrainResult,
  TerrainSample,
} from './types';

/**
 * Ordered bounds of the slope-percent classification. Exported so UI copy and
 * maths can never disagree:
 *   ≤ 2 % Flat · ≤ 5 % Gentle · ≤ 10 % Rolling · ≤ 20 % Hilly · > 20 % Steep
 */
export const TERRAIN_THRESHOLDS: { flat: number; gentle: number; rolling: number; hilly: number } = {
  flat: 2,
  gentle: 5,
  rolling: 10,
  hilly: 20,
};

/** Elevation deltas smaller than this are floating-point noise, not climb. */
const ELEVATION_EPSILON = 1e-9;

const RAD_TO_DEG = 180 / Math.PI;

/** Classify a slope magnitude (percent grade) into a terrain category. */
export function classifySlope(maxSlopePct: number): TerrainCategory {
  if (typeof maxSlopePct !== 'number' || !Number.isFinite(maxSlopePct)) {
    throw new Error('maxSlopePct must be a finite number.');
  }
  if (maxSlopePct < 0) {
    throw new Error('maxSlopePct must be greater than or equal to 0.');
  }
  if (maxSlopePct <= TERRAIN_THRESHOLDS.flat) return 'Flat';
  if (maxSlopePct <= TERRAIN_THRESHOLDS.gentle) return 'Gentle';
  if (maxSlopePct <= TERRAIN_THRESHOLDS.rolling) return 'Rolling';
  if (maxSlopePct <= TERRAIN_THRESHOLDS.hilly) return 'Hilly';
  return 'Steep';
}

/** Fill non-finite holes by linear interpolation; edge holes are extended flat. */
function interpolateMissing(values: number[]): number[] {
  const result = values.slice();
  const isMissing = (value: number): boolean => typeof value !== 'number' || !Number.isFinite(value);

  let firstValid = -1;
  for (let i = 0; i < result.length; i += 1) {
    if (!isMissing(result[i])) {
      firstValid = i;
      break;
    }
  }
  if (firstValid === -1) return result; // caller throws on an all-missing series

  for (let i = 0; i < firstValid; i += 1) result[i] = result[firstValid];

  let index = firstValid;
  while (index < result.length) {
    if (!isMissing(result[index])) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < result.length && isMissing(result[end])) end += 1;
    const previous = result[index - 1];
    if (end >= result.length) {
      for (let k = index; k < result.length; k += 1) result[k] = previous;
    } else {
      const next = result[end];
      for (let k = index; k < end; k += 1) {
        result[k] = previous + ((next - previous) * (k - index + 1)) / (end - index + 1);
      }
    }
    index = end;
  }
  return result;
}

/** Symmetric moving average, window in samples (legacy edge behaviour). */
function movingAverage(values: number[], window: number): number[] {
  if (window <= 1) return values.slice();
  const half = Math.floor(window / 2);
  return values.map((_, index) => {
    const low = Math.max(0, index - half);
    const high = Math.min(values.length - 1, index + half);
    let sum = 0;
    for (let k = low; k <= high; k += 1) sum += values[k];
    return sum / (high - low + 1);
  });
}

function readOptions(options: TerrainOptions): { smoothingWindow: number; noDataBelow: number | null } {
  const smoothingWindow = options.smoothingWindow ?? 0;
  if (!Number.isInteger(smoothingWindow) || smoothingWindow < 0) {
    throw new Error('smoothingWindow must be a non-negative integer number of samples.');
  }
  let noDataBelow: number | null = null;
  if (options.noDataBelow !== undefined) {
    if (typeof options.noDataBelow !== 'number' || !Number.isFinite(options.noDataBelow)) {
      throw new Error('noDataBelow must be a finite number of metres.');
    }
    noDataBelow = options.noDataBelow;
  }
  return { smoothingWindow, noDataBelow };
}

/** Core profile statistics: gain, descent, distance, grades, category. */
export function computeTerrainProfile(
  samples: TerrainSample[],
  options: TerrainOptions = {},
): TerrainResult {
  if (!Array.isArray(samples) || samples.length < 2) {
    throw new Error('A terrain profile needs at least 2 samples.');
  }

  const distances = samples.map((sample, index) => {
    if (!sample || typeof sample !== 'object') {
      throw new Error(`Sample ${index + 1} must be a { distance, elevation } object.`);
    }
    if (typeof sample.distance !== 'number' || !Number.isFinite(sample.distance)) {
      throw new Error(`Sample ${index + 1} has a non-finite distance.`);
    }
    return sample.distance;
  });
  for (let i = 1; i < distances.length; i += 1) {
    if (distances[i] < distances[i - 1] - 1e-9) {
      throw new Error(
        `Sample distances must be non-decreasing (sample ${i + 1} is ${distances[i]} m after ${distances[i - 1]} m).`,
      );
    }
  }

  const { smoothingWindow, noDataBelow } = readOptions(options);

  let elevations = samples.map((sample) =>
    typeof sample.elevation === 'number' && Number.isFinite(sample.elevation) ? sample.elevation : Number.NaN,
  );
  if (noDataBelow !== null) {
    elevations = elevations.map((elevation) =>
      Number.isFinite(elevation) && elevation < noDataBelow ? Number.NaN : elevation,
    );
  }
  if (elevations.every((elevation) => !Number.isFinite(elevation))) {
    throw new Error('No valid elevation values in the profile (every sample is no-data).');
  }
  elevations = interpolateMissing(elevations);
  if (smoothingWindow > 1) {
    elevations = movingAverage(elevations, smoothingWindow);
  }

  const processed: TerrainSample[] = samples.map((sample, index) => {
    const output: TerrainSample = { distance: sample.distance, elevation: elevations[index] };
    if (typeof sample.lat === 'number' && Number.isFinite(sample.lat)) output.lat = sample.lat;
    if (typeof sample.lon === 'number' && Number.isFinite(sample.lon)) output.lon = sample.lon;
    return output;
  });

  let gain = 0;
  let descent = 0;
  for (let i = 1; i < processed.length; i += 1) {
    const delta = processed[i].elevation - processed[i - 1].elevation;
    if (delta > ELEVATION_EPSILON) gain += delta;
    else if (delta < -ELEVATION_EPSILON) descent -= delta;
  }

  let min = processed[0].elevation;
  let max = processed[0].elevation;
  let elevationSum = 0;
  for (const sample of processed) {
    if (sample.elevation < min) min = sample.elevation;
    if (sample.elevation > max) max = sample.elevation;
    elevationSum += sample.elevation;
  }

  const segments: SlopeSegment[] = [];
  for (let i = 1; i < processed.length; i += 1) {
    const run = processed[i].distance - processed[i - 1].distance;
    const rise = processed[i].elevation - processed[i - 1].elevation;
    const slopePct = run > 0 ? (rise / run) * 100 : 0;
    const slopeDeg = run > 0 ? Math.atan2(rise, run) * RAD_TO_DEG : 0;
    segments.push({
      index: segments.length,
      from: processed[i - 1].distance,
      to: processed[i].distance,
      run,
      rise,
      slopePct,
      slopeDeg,
    });
  }

  let maxSlopePct = 0;
  let maxSlopeDeg = 0;
  let maxSlopeAt = processed[0].distance;
  for (const segment of segments) {
    const magnitude = Math.abs(segment.slopePct);
    if (magnitude > maxSlopePct) {
      maxSlopePct = magnitude;
      maxSlopeDeg = Math.abs(segment.slopeDeg);
      maxSlopeAt = segment.from;
    }
  }

  const totalDistance = processed[processed.length - 1].distance - processed[0].distance;
  const avgSlopePct = totalDistance > 0 ? (gain / totalDistance) * 100 : 0;
  const startElevation = processed[0].elevation;
  const endElevation = processed[processed.length - 1].elevation;

  return {
    samples: processed,
    distance: totalDistance,
    gain,
    descent,
    net: endElevation - startElevation,
    min,
    max,
    range: max - min,
    startElevation,
    endElevation,
    avgSlopePct,
    maxSlopePct,
    maxSlopeDeg,
    maxSlopeAt,
    category: classifySlope(maxSlopePct),
    segments,
    meanElevation: elevationSum / processed.length,
  };
}
