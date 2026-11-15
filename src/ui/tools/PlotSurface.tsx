/**
 * GEODESIA — white graph plotting surface ("coordinate sheet").
 *
 * The engineering drawing the legacy calculator showed for grid work: a white
 * sheet with a fine graph grid, auto-scaled metre ticks and labelled axes, the
 * parcel ring with numbered vertices, per-leg distance labels, area/perimeter
 * annotation, north arrow, scale bar and centroid marker. Pure SVG, no map
 * tiles; equal metres-per-pixel on both axes so the parcel cannot be distorted.
 */
import { useEffect, useRef, useState } from 'react';
import { fmtNumber } from '../../math';
import { cx, niceStep, clamp } from './utils';

export interface PlotVertex {
  x: number;
  y: number;
  label?: string;
}

export interface PlotSurfaceProps {
  vertices: ReadonlyArray<PlotVertex>;
  centroid?: { x: number; y: number } | null;
  /** Per-leg distances in metres, in ring order (closing leg last). */
  legDistances?: ReadonlyArray<number>;
  areaM2?: number | null;
  perimeterM?: number | null;
  axisLabels?: { x: string; y: string };
  /** Direction arrow label ('N' for grid north, 'Y' for local axes). */
  northLabel?: string;
  title?: string;
  ariaLabel?: string;
  className?: string;
}

const PAD = { left: 58, right: 20, top: 30, bottom: 42 };
const MIN_WIDTH = 300;

function ticksFor(min: number, max: number, targetCount: number): { step: number; values: number[] } {
  const span = Math.max(max - min, 1e-9);
  const step = niceStep(span / Math.max(2, targetCount));
  const first = Math.ceil(min / step) * step;
  const values: number[] = [];
  for (let value = first; value <= max + step * 1e-9; value += step) {
    values.push(Math.abs(value) < step * 1e-9 ? 0 : value);
  }
  return { step, values };
}

function decimalsForStep(step: number): number {
  if (step >= 100) return 0;
  if (step >= 10) return 0;
  if (step >= 1) return 0;
  if (step >= 0.1) return 1;
  return 2;
}

export function PlotSurface({
  vertices,
  centroid,
  legDistances,
  areaM2,
  perimeterM,
  axisLabels = { x: 'E (m)', y: 'N (m)' },
  northLabel = 'N',
  title = 'Parcel plot',
  ariaLabel,
  className,
}: PlotSurfaceProps) {
  const plotRef = useRef<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(640);

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

  const height = clamp(Math.round(width * 0.62), 300, 540);
  const plotWidth = Math.max(1, width - PAD.left - PAD.right);
  const plotHeight = Math.max(1, height - PAD.top - PAD.bottom);

  if (vertices.length < 3) {
    return (
      <div className={cx('plot-surface plot-surface--empty', className)} ref={plotRef}>
        <div className="plot-surface__empty">
          <p className="empty__title">Coordinate sheet awaiting vertices</p>
          <p className="empty__text">
            Add at least three vertices — paste coordinates, edit the table or click the map — and
            the ring is plotted here with a metre grid, area and leg lengths.
          </p>
        </div>
      </div>
    );
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const vertex of vertices) {
    minX = Math.min(minX, vertex.x);
    maxX = Math.max(maxX, vertex.x);
    minY = Math.min(minY, vertex.y);
    maxY = Math.max(maxY, vertex.y);
  }
  const spanX = Math.max(maxX - minX, 1e-6);
  const spanY = Math.max(maxY - minY, 1e-6);
  const scale = Math.min(plotWidth / (spanX * 1.18), plotHeight / (spanY * 1.18));
  const midX = (minX + maxX) / 2;
  const midY = (minY + maxY) / 2;
  const centrePx = PAD.left + plotWidth / 2;
  const centrePy = PAD.top + plotHeight / 2;
  const px = (x: number): number => centrePx + (x - midX) * scale;
  const py = (y: number): number => centrePy - (y - midY) * scale;

  const dataMinX = midX - (plotWidth / 2) / scale;
  const dataMaxX = midX + (plotWidth / 2) / scale;
  const dataMinY = midY - (plotHeight / 2) / scale;
  const dataMaxY = midY + (plotHeight / 2) / scale;

  const xAxis = ticksFor(dataMinX, dataMaxX, width < 480 ? 4 : 6);
  const yAxis = ticksFor(dataMinY, dataMaxY, width < 480 ? 4 : 5);
  const xDecimals = decimalsForStep(xAxis.step);
  const yDecimals = decimalsForStep(yAxis.step);

  const ringPoints = vertices.map((vertex) => `${px(vertex.x).toFixed(1)},${py(vertex.y).toFixed(1)}`).join(' ');

  // Scale bar: a round metre length close to a fifth of the plot width.
  const barMetres = Math.max(niceStep(spanX / 5), 1);
  const barPixels = Math.min(barMetres * scale, plotWidth * 0.4);
  const barX = PAD.left + 12;
  const barY = PAD.top + plotHeight - 10;

  const description =
    ariaLabel ??
    `${title}: ${vertices.length} vertices on a ${axisLabels.x}/${axisLabels.y} grid.${
      areaM2 !== null && areaM2 !== undefined ? ` Area ${fmtNumber(areaM2, 2)} square metres.` : ''
    }${perimeterM !== null && perimeterM !== undefined ? ` Perimeter ${fmtNumber(perimeterM, 2)} metres.` : ''} Vertex coordinates are listed in the table below the plot.`;

  const summaryId = `plot-summary-${Math.round(vertices.length)}-${Math.round(width)}`;

  return (
    <figure
      className={cx('plot-surface', className)}
      ref={plotRef}
      tabIndex={0}
      role="group"
      aria-label={title}
      aria-describedby={summaryId}
    >
      <div className="plot-surface__head">
        <span className="plot-surface__title">{title}</span>
        <span className="plot-surface__meta">
          grid · {axisLabels.x} / {axisLabels.y}
        </span>
      </div>

      <p className="sr-only" id={summaryId}>
        {description}
        {centroid
          ? ` Centroid at ${axisLabels.x.replace(/\s*\(.*\)/, '')} ${fmtNumber(centroid.x, 2)}, ${axisLabels.y.replace(/\s*\(.*\)/, '')} ${fmtNumber(centroid.y, 2)}.`
          : ''}
      </p>

      <svg
        className="plot-surface__svg"
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={description}
      >
        <rect className="plot-surface__sheet" x={0} y={0} width={width} height={height} rx={2} />

        {/* fine graph paper + major grid */}
        <g className="plot-surface__grid-minor" aria-hidden="true">
          {Array.from({ length: Math.max(0, Math.round((dataMaxX - dataMinX) / (xAxis.step / 5))) }).map(
            (_, index) => {
              const value = dataMinX + index * (xAxis.step / 5);
              return <line key={`mx-${index}`} x1={px(value)} x2={px(value)} y1={PAD.top} y2={PAD.top + plotHeight} />;
            },
          )}
          {Array.from({ length: Math.max(0, Math.round((dataMaxY - dataMinY) / (yAxis.step / 5))) }).map(
            (_, index) => {
              const value = dataMinY + index * (yAxis.step / 5);
              return <line key={`my-${index}`} x1={PAD.left} x2={PAD.left + plotWidth} y1={py(value)} y2={py(value)} />;
            },
          )}
        </g>
        <g className="plot-surface__grid-major" aria-hidden="true">
          {xAxis.values.map((value, index) => (
            <line key={`gx-${index}`} x1={px(value)} x2={px(value)} y1={PAD.top} y2={PAD.top + plotHeight} />
          ))}
          {yAxis.values.map((value, index) => (
            <line key={`gy-${index}`} x1={PAD.left} x2={PAD.left + plotWidth} y1={py(value)} y2={py(value)} />
          ))}
        </g>

        {/* axes + tick labels */}
        <g className="plot-surface__axis" aria-hidden="true">
          <line x1={PAD.left} x2={PAD.left + plotWidth} y1={PAD.top + plotHeight} y2={PAD.top + plotHeight} />
          <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={PAD.top + plotHeight} />
        </g>
        <g className="plot-surface__ticks" aria-hidden="true">
          {xAxis.values.map((value, index) => (
            <text key={`tx-${index}`} x={px(value)} y={PAD.top + plotHeight + 14} textAnchor="middle">
              {fmtNumber(value, xDecimals)}
            </text>
          ))}
          {yAxis.values.map((value, index) => (
            <text key={`ty-${index}`} x={PAD.left - 8} y={py(value) + 3} textAnchor="end">
              {fmtNumber(value, yDecimals)}
            </text>
          ))}
          <text className="plot-surface__axis-label" x={PAD.left + plotWidth} y={height - 8} textAnchor="end">
            {axisLabels.x}
          </text>
          <text className="plot-surface__axis-label" x={10} y={PAD.top - 12} textAnchor="start">
            {axisLabels.y}
          </text>
        </g>

        {/* parcel ring */}
        <polygon className="plot-surface__ring" points={ringPoints} />

        {/* legs + distance labels */}
        <g className="plot-surface__legs" aria-hidden="true">
          {vertices.map((vertex, index) => {
            const next = vertices[(index + 1) % vertices.length];
            if (!next) return null;
            const midXpx = (px(vertex.x) + px(next.x)) / 2;
            const midYpx = (py(vertex.y) + py(next.y)) / 2;
            const distance =
              legDistances && legDistances.length > index
                ? legDistances[index]
                : Math.hypot(next.x - vertex.x, next.y - vertex.y);
            return (
              <g key={`leg-${index}`}>
                <line
                  className="plot-surface__leg"
                  x1={px(vertex.x)}
                  y1={py(vertex.y)}
                  x2={px(next.x)}
                  y2={py(next.y)}
                />
                <text className="plot-surface__leg-label" x={midXpx} y={midYpx - 4} textAnchor="middle">
                  {fmtNumber(distance, distance < 100 ? 2 : 1)} m
                </text>
              </g>
            );
          })}
        </g>

        {/* vertices */}
        <g className="plot-surface__vertices" aria-hidden="true">
          {vertices.map((vertex, index) => (
            <g key={`vertex-${index}`}>
              <circle className="plot-surface__vertex" cx={px(vertex.x)} cy={py(vertex.y)} r={3.4} />
              <text
                className="plot-surface__vertex-label"
                x={px(vertex.x) + 7}
                y={py(vertex.y) - 7}
                textAnchor="start"
              >
                {vertex.label ?? fmtNumber(index + 1, 0)}
              </text>
            </g>
          ))}
        </g>

        {/* centroid marker */}
        {centroid ? (
          <g className="plot-surface__centroid" aria-hidden="true">
            <circle cx={px(centroid.x)} cy={py(centroid.y)} r={2.6} />
            <line x1={px(centroid.x) - 8} x2={px(centroid.x) + 8} y1={py(centroid.y)} y2={py(centroid.y)} />
            <line x1={px(centroid.x)} x2={px(centroid.x)} y1={py(centroid.y) - 8} y2={py(centroid.y) + 8} />
            <text className="plot-surface__centroid-label" x={px(centroid.x) + 10} y={py(centroid.y) + 12}>
              centroid
            </text>
          </g>
        ) : null}

        {/* annotations: area/perimeter, north arrow, scale bar */}
        <g className="plot-surface__annotations" aria-hidden="true">
          <rect className="plot-surface__annotation-box" x={PAD.left + 10} y={PAD.top + 10} width={190} height={46} rx={2} />
          <text className="plot-surface__annotation-label" x={PAD.left + 20} y={PAD.top + 26}>
            AREA
          </text>
          <text className="plot-surface__annotation-value" x={PAD.left + 20} y={PAD.top + 44}>
            {areaM2 !== null && areaM2 !== undefined ? `${fmtNumber(areaM2, 2)} m²` : '—'}
          </text>
          <text className="plot-surface__annotation-label" x={PAD.left + 112} y={PAD.top + 26}>
            PERIMETER
          </text>
          <text className="plot-surface__annotation-value" x={PAD.left + 112} y={PAD.top + 44}>
            {perimeterM !== null && perimeterM !== undefined ? `${fmtNumber(perimeterM, 2)} m` : '—'}
          </text>

          <g className="plot-surface__north">
            <line x1={PAD.left + plotWidth - 26} y1={PAD.top + 30} x2={PAD.left + plotWidth - 26} y2={PAD.top + 10} />
            <polygon
              points={`${PAD.left + plotWidth - 31},${PAD.top + 18} ${PAD.left + plotWidth - 26},${PAD.top + 8} ${PAD.left + plotWidth - 21},${PAD.top + 18}`}
            />
            <text x={PAD.left + plotWidth - 26} y={PAD.top + 44} textAnchor="middle">
              {northLabel}
            </text>
          </g>

          <g className="plot-surface__scalebar">
            <line x1={barX} x2={barX + barPixels} y1={barY} y2={barY} />
            <line x1={barX} x2={barX} y1={barY - 4} y2={barY + 4} />
            <line x1={barX + barPixels} x2={barX + barPixels} y1={barY - 4} y2={barY + 4} />
            <text x={barX + barPixels / 2} y={barY - 7} textAnchor="middle">
              {fmtNumber(barMetres, 0)} m
            </text>
          </g>
        </g>
      </svg>
    </figure>
  );
}
