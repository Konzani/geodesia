/**
 * GEODESIA — hand-rolled SVG elevation profile chart.
 *
 * No chart library: an area + line profile over a distance axis, slope shading
 * bands derived from the same thresholds as the terrain classification, a hover
 * crosshair with pinned tooltip readout, and left/right keyboard sampling.
 * The viewBox tracks the measured plot width so typography stays at its
 * designed size from 360px to full desktop width.
 */
import { useEffect, useId, useRef, useState } from 'react';
import type { KeyboardEvent, PointerEvent } from 'react';
import type { SlopeSegment, TerrainSample } from '../../math/types';
import { TERRAIN_THRESHOLDS, fmtLength, fmtNumber } from '../../math';
import { cx, clamp, niceTicks } from './utils';

export interface ProfileChartProps {
  samples: ReadonlyArray<TerrainSample>;
  /** Pre-computed slope segments; when omitted they are derived locally. */
  segments?: ReadonlyArray<SlopeSegment>;
  title?: string;
  height?: number;
  /** Overrides the generated accessible description. */
  ariaLabel?: string;
  className?: string;
}

interface PlotGeometry {
  left: number;
  right: number;
  top: number;
  bottom: number;
  plotWidth: number;
  plotHeight: number;
}

const MIN_WIDTH = 300;

function plotGeometry(width: number, height: number): PlotGeometry {
  const left = width < 440 ? 42 : 50;
  const right = 14;
  const top = 16;
  const bottom = 30;
  return {
    left,
    right,
    top,
    bottom,
    plotWidth: Math.max(1, width - left - right),
    plotHeight: Math.max(1, height - top - bottom),
  };
}

/** Percent grade between two consecutive samples (guard against zero run). */
function gradeBetween(from: TerrainSample, to: TerrainSample): number {
  const run = to.distance - from.distance;
  if (!Number.isFinite(run) || Math.abs(run) < 1e-9) return 0;
  return ((to.elevation - from.elevation) / run) * 100;
}

export function ProfileChart({
  samples,
  segments,
  title = 'Elevation profile',
  height = 260,
  ariaLabel,
  className,
}: ProfileChartProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(720);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [pinnedIndex, setPinnedIndex] = useState<number | null>(null);
  const [keyboardIndex, setKeyboardIndex] = useState<number | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const instructionsId = useId();
  const liveId = useId();

  // Measure the plot so the viewBox matches CSS pixels (labels stay legible).
  useEffect(() => {
    const element = plotRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const next = Math.round(entry.contentRect.width);
        if (next > 0) setWidth(Math.max(MIN_WIDTH, next));
      }
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Reset transient selection when the profile changes.
  useEffect(() => {
    setHoverIndex(null);
    setPinnedIndex(null);
    setKeyboardIndex(null);
  }, [samples]);

  const usable = samples.filter(
    (sample) => Number.isFinite(sample.distance) && Number.isFinite(sample.elevation),
  );

  if (usable.length === 0) {
    return (
      <div className={cx('chart-shell', 'profile-chart', className)}>
        <div className="chart-shell__head">
          <span className="chart-shell__title">{title}</span>
        </div>
        <div className="chart-empty">
          <p className="empty__text">
            No profile yet. Pick two points on the map, draw a route or upload a CSV with distance
            and elevation columns.
          </p>
        </div>
      </div>
    );
  }

  const geometry = plotGeometry(width, height);
  const { left, top, plotWidth, plotHeight } = geometry;
  const baseline = top + plotHeight;

  const totalDistance = Math.max(usable[usable.length - 1].distance, 0);
  const distanceSpan = totalDistance > 0 ? totalDistance : 1;

  let minElevation = Infinity;
  let maxElevation = -Infinity;
  for (const sample of usable) {
    if (sample.elevation < minElevation) minElevation = sample.elevation;
    if (sample.elevation > maxElevation) maxElevation = sample.elevation;
  }
  if (!Number.isFinite(minElevation) || !Number.isFinite(maxElevation)) {
    minElevation = 0;
    maxElevation = 1;
  }
  let low = minElevation;
  let high = maxElevation;
  if (high - low < 0.5) {
    low -= 1;
    high += 1;
  }
  const elevationPad = (high - low) * 0.1;
  low -= elevationPad;
  high += elevationPad;
  const elevationSpan = high - low;

  const xScale = (distance: number): number =>
    left + clamp(distance / distanceSpan, 0, 1) * plotWidth;
  const yScale = (elevation: number): number =>
    top + (1 - clamp((elevation - low) / elevationSpan, 0, 1)) * plotHeight;

  const linePoints = usable.map((sample) => [xScale(sample.distance), yScale(sample.elevation)] as const);
  const linePath = linePoints
    .map(([x, y], index) => `${index === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`)
    .join(' ');
  const areaPath = `${linePath} L${(left + plotWidth).toFixed(1)} ${baseline.toFixed(1)} L${left.toFixed(
    1,
  )} ${baseline.toFixed(1)} Z`;

  const xTicks = niceTicks(0, totalDistance / 1000, width < 440 ? 4 : 6);
  const yTicks = niceTicks(low, high, 4);

  const gradeSegments: Array<{ x1: number; x2: number; y1: number; y2: number; grade: number }> = [];
  for (let index = 1; index < usable.length; index += 1) {
    const previous = usable[index - 1];
    const current = usable[index];
    gradeSegments.push({
      x1: xScale(previous.distance),
      x2: xScale(current.distance),
      y1: yScale(previous.elevation),
      y2: yScale(current.elevation),
      grade: gradeBetween(previous, current),
    });
  }

  // Slope shading intervals: prefer the caller's smoothed segments so the chart
  // and the station table describe the same grades.
  const elevationAt = (distance: number): number => {
    if (distance <= usable[0].distance) return usable[0].elevation;
    const last = usable[usable.length - 1];
    if (distance >= last.distance) return last.elevation;
    for (let index = 1; index < usable.length; index += 1) {
      const from = usable[index - 1];
      const to = usable[index];
      if (distance <= to.distance) {
        const run = to.distance - from.distance;
        if (Math.abs(run) < 1e-9) return to.elevation;
        const ratio = (distance - from.distance) / run;
        return from.elevation + (to.elevation - from.elevation) * ratio;
      }
    }
    return last.elevation;
  };

  const shading =
    segments && segments.length > 0
      ? segments.map((segment) => ({
          x1: xScale(segment.from),
          x2: xScale(segment.to),
          y1: yScale(elevationAt(segment.from)),
          y2: yScale(elevationAt(segment.to)),
          grade: segment.slopePct,
        }))
      : gradeSegments;

  const activeIndex = pinnedIndex ?? keyboardIndex ?? hoverIndex;
  const active = activeIndex !== null ? usable[activeIndex] : undefined;
  const activeX = active ? xScale(active.distance) : 0;
  const activeY = active ? yScale(active.elevation) : 0;
  const activeGrade =
    activeIndex !== null && activeIndex > 0
      ? gradeBetween(usable[activeIndex - 1], usable[activeIndex])
      : null;

  const stationLabel = (index: number): string =>
    `STA ${String(index + 1).padStart(3, '0')}`;

  const describe = (index: number): string => {
    const sample = usable[index];
    const grade =
      index > 0 ? gradeBetween(usable[index - 1], sample) : null;
    return `${stationLabel(index)}: chainage ${fmtNumber(sample.distance / 1000, 2)} kilometres, elevation ${fmtNumber(
      sample.elevation,
      1,
    )} metres${grade === null ? '' : `, grade ${fmtSignedPercent(grade)}`}`;
  };

  const description =
    ariaLabel ??
    `Elevation profile: ${fmtLength(totalDistance, 'km')} sampled at ${fmtNumber(usable.length, 0)} stations, ${fmtNumber(
      minElevation,
      0,
    )} to ${fmtNumber(maxElevation, 0)} metres. Press the left and right arrow keys to sample stations.`;

  const selectIndex = (index: number) => {
    const next = clamp(index, 0, usable.length - 1);
    setKeyboardIndex(next);
    setAnnouncement(describe(next));
  };

  const handleKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
    const current = keyboardIndex ?? pinnedIndex ?? 0;
    switch (event.key) {
      case 'ArrowRight':
      case 'ArrowUp':
        event.preventDefault();
        selectIndex(current + (event.shiftKey ? 10 : 1));
        break;
      case 'ArrowLeft':
      case 'ArrowDown':
        event.preventDefault();
        selectIndex(current - (event.shiftKey ? 10 : 1));
        break;
      case 'Home':
        event.preventDefault();
        selectIndex(0);
        break;
      case 'End':
        event.preventDefault();
        selectIndex(usable.length - 1);
        break;
      case 'Escape':
        setKeyboardIndex(null);
        setPinnedIndex(null);
        setHoverIndex(null);
        setAnnouncement('');
        break;
      default:
        break;
    }
  };

  const nearestIndex = (clientX: number, target: SVGSVGElement): number => {
    const rect = target.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const svgX = ((clientX - rect.left) / rect.width) * width;
    const ratio = clamp((svgX - left) / plotWidth, 0, 1);
    const targetDistance = ratio * distanceSpan;
    let bestIndex = 0;
    let bestDelta = Infinity;
    for (let index = 0; index < usable.length; index += 1) {
      const delta = Math.abs(usable[index].distance - targetDistance);
      if (delta < bestDelta) {
        bestDelta = delta;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    if (pinnedIndex !== null) return;
    setHoverIndex(nearestIndex(event.clientX, event.currentTarget));
  };

  const handlePointerLeave = () => {
    if (pinnedIndex === null) setHoverIndex(null);
  };

  const handleClick = (event: PointerEvent<SVGSVGElement>) => {
    const index = nearestIndex(event.clientX, event.currentTarget);
    if (pinnedIndex === index) {
      setPinnedIndex(null);
      return;
    }
    setPinnedIndex(index);
    setAnnouncement(`${describe(index)} (pinned)`);
  };

  const tooltipLeft = clamp((activeX / width) * 100, 6, 94);
  const tooltipTop = clamp((activeY / height) * 100, 4, 92);

  return (
    <div className={cx('chart-shell', 'profile-chart', className)}>
      <div className="chart-shell__head">
        <span className="chart-shell__title">{title}</span>
        <span className="chart-shell__legend">
          <span className="legend-key">Elevation</span>
          <span className="legend-key legend-key--slope">
            Slope ≥ {fmtNumber(TERRAIN_THRESHOLDS.flat, 0)}%
          </span>
          <span className="chart__status">
            {pinnedIndex !== null
              ? `${stationLabel(pinnedIndex)} pinned · Esc to clear`
              : `${fmtLength(totalDistance, 'km')} · ${fmtNumber(minElevation, 0)}–${fmtNumber(
                  maxElevation,
                  0,
                )} m`}
          </span>
        </span>
      </div>

      <p className="sr-only" id={instructionsId}>
        Elevation profile chart. Focus the chart and use the left and right arrow keys to move
        between stations, Home and End to jump to the ends, and Escape to clear the selection.
        Click or tap the chart to pin a station readout.
      </p>
      <p className="sr-only" id={liveId} aria-live="polite">
        {announcement}
      </p>

      <div className="chart__plot" ref={plotRef}>
        <svg
          className="chart"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={description}
          aria-describedby={`${instructionsId} ${liveId}`}
          tabIndex={0}
          onPointerMove={handlePointerMove}
          onPointerLeave={handlePointerLeave}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
        >
          <g className="chart__grid">
            {xTicks.map((tick, index) => {
              const x = xScale(tick * 1000);
              return (
                <line
                  key={`x-${index}`}
                  x1={x.toFixed(1)}
                  x2={x.toFixed(1)}
                  y1={top}
                  y2={baseline}
                />
              );
            })}
            {yTicks.map((tick, index) => {
              const y = yScale(tick);
              return (
                <line key={`y-${index}`} x1={left} x2={left + plotWidth} y1={y.toFixed(1)} y2={y.toFixed(1)} />
              );
            })}
          </g>

          {/* slope shading bands: steeper segments are shaded darker under the line */}
          <g aria-hidden="true">
            {shading.map((segment, index) => {
              const magnitude = Math.abs(segment.grade);
              if (magnitude < TERRAIN_THRESHOLDS.flat) return null;
              const opacity = clamp(0.12 + magnitude / 260, 0.12, 0.46);
              return (
                <path
                  key={`slope-${index}`}
                  className="chart__slope"
                  fillOpacity={opacity}
                  d={`M${segment.x1.toFixed(1)} ${baseline.toFixed(1)} L${segment.x1.toFixed(
                    1,
                  )} ${segment.y1.toFixed(1)} L${segment.x2.toFixed(1)} ${segment.y2.toFixed(
                    1,
                  )} L${segment.x2.toFixed(1)} ${baseline.toFixed(1)} Z`}
                />
              );
            })}
          </g>

          <path className="chart__area" d={areaPath} />
          <path className="chart__line" d={linePath} />

          <g className="chart__axis">
            <line x1={left} x2={left + plotWidth} y1={baseline} y2={baseline} />
            <line x1={left} x2={left} y1={top} y2={baseline} />
          </g>

          <g className="chart__labels" aria-hidden="true">
            {xTicks.map((tick, index) => {
              const x = xScale(tick * 1000);
              const decimals = totalDistance < 3000 ? 2 : totalDistance < 30000 ? 1 : 0;
              return (
                <text
                  key={`xl-${index}`}
                  className="chart__label"
                  x={x.toFixed(1)}
                  y={baseline + 12}
                  textAnchor="middle"
                >
                  {fmtNumber(tick, decimals)}
                </text>
              );
            })}
            {yTicks.map((tick, index) => {
              const y = yScale(tick);
              return (
                <text
                  key={`yl-${index}`}
                  className="chart__label"
                  x={left - 8}
                  y={(y + 3).toFixed(1)}
                  textAnchor="end"
                >
                  {fmtNumber(tick, high - low > 50 ? 0 : 1)}
                </text>
              );
            })}
            <text className="chart__label chart__label--axis" x={left - 8} y={top - 4} textAnchor="end">
              m
            </text>
            <text
              className="chart__label chart__label--axis"
              x={left + plotWidth}
              y={baseline + 24}
              textAnchor="end"
            >
              km
            </text>
          </g>

          {activeIndex !== null && active ? (
            <g className="chart__crosshair" aria-hidden="true">
              <line x1={activeX.toFixed(1)} x2={activeX.toFixed(1)} y1={top} y2={baseline} />
              <circle className="chart__dot" cx={activeX.toFixed(1)} cy={activeY.toFixed(1)} r={3.2} />
            </g>
          ) : null}
        </svg>

        {activeIndex !== null && active ? (
          <div
            className="chart__tooltip"
            style={{ left: `${tooltipLeft}%`, top: `${tooltipTop}%` }}
            aria-hidden="true"
          >
            <span className="chart__tooltip-title">{stationLabel(activeIndex)}</span>
            <span>
              {fmtNumber(active.distance / 1000, 2)} km · {fmtNumber(active.elevation, 1)} m
            </span>
            {activeGrade !== null ? (
              <span>
                grade {fmtSignedPercent(activeGrade)} · {fmtNumber(Math.atan(activeGrade / 100) * (180 / Math.PI), 1)}°
              </span>
            ) : null}
            {pinnedIndex !== null ? <span className="chart__tooltip-note">pinned</span> : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function fmtSignedPercent(value: number): string {
  const sign = value > 0 ? '+' : '';
  return `${sign}${fmtNumber(value, 1)} %`;
}
