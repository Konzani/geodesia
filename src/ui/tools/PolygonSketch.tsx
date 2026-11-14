/**
 * GEODESIA — local Cartesian parcel sketch.
 *
 * The map cannot georeference bare X/Y metres, so Cartesian polygons are
 * previewed on a plain graticule sketch instead: hairline grid, ring, numbered
 * vertices and centroid. Pure SVG, no map tiles, safe during SSR.
 */
import type { XYPoint } from '../../math/types';
import { fmtNumber } from '../../math';

export interface PolygonSketchProps {
  points: ReadonlyArray<XYPoint>;
  centroid?: XYPoint | null;
}

const WIDTH = 320;
const HEIGHT = 210;
const PAD = 22;

export function PolygonSketch({ points, centroid }: PolygonSketchProps) {
  if (points.length < 3) {
    return (
      <div className="poly-sketch-empty">
        <p className="empty__text">
          Add at least three vertices to preview the parcel. Cartesian X/Y cannot be placed on a
          basemap — switch to WGS 84 to pick vertices on the map.
        </p>
      </div>
    );
  }

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }
  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  const scale = Math.min((WIDTH - PAD * 2) / spanX, (HEIGHT - PAD * 2) / spanY);
  const offsetX = (WIDTH - spanX * scale) / 2;
  const offsetY = (HEIGHT - spanY * scale) / 2;

  const xScale = (value: number): number => offsetX + (value - minX) * scale;
  const yScale = (value: number): number => HEIGHT - (offsetY + (value - minY) * scale);

  const ring = points.map((point) => `${xScale(point.x).toFixed(1)},${yScale(point.y).toFixed(1)}`).join(' ');

  return (
    <svg
      className="poly-sketch"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      role="img"
      aria-label={`Parcel sketch with ${fmtNumber(points.length, 0)} vertices. Planar X/Y preview only.`}
    >
      <g className="poly-sketch__grid" aria-hidden="true">
        {[0, 1, 2, 3, 4].map((index) => (
          <line
            key={`v-${index}`}
            x1={PAD + ((WIDTH - PAD * 2) / 4) * index}
            x2={PAD + ((WIDTH - PAD * 2) / 4) * index}
            y1={PAD / 2}
            y2={HEIGHT - PAD / 2}
          />
        ))}
        {[0, 1, 2, 3, 4].map((index) => (
          <line
            key={`h-${index}`}
            x1={PAD / 2}
            x2={WIDTH - PAD / 2}
            y1={PAD + ((HEIGHT - PAD * 2) / 4) * index}
            y2={PAD + ((HEIGHT - PAD * 2) / 4) * index}
          />
        ))}
      </g>

      <polygon className="poly-sketch__ring" points={ring} />

      {points.map((point, index) => (
        <g key={`vertex-${index}`} className="poly-sketch__vertex">
          <circle cx={xScale(point.x).toFixed(1)} cy={yScale(point.y).toFixed(1)} r={3} />
          <text
            x={xScale(point.x).toFixed(1)}
            y={(yScale(point.y) - 8).toFixed(1)}
            textAnchor="middle"
            className="poly-sketch__label"
          >
            {fmtNumber(index + 1, 0)}
          </text>
        </g>
      ))}

      {centroid ? (
        <g className="poly-sketch__centroid" aria-hidden="true">
          <circle cx={xScale(centroid.x).toFixed(1)} cy={yScale(centroid.y).toFixed(1)} r={2.4} />
          <line
            x1={(xScale(centroid.x) - 7).toFixed(1)}
            x2={(xScale(centroid.x) + 7).toFixed(1)}
            y1={yScale(centroid.y).toFixed(1)}
            y2={yScale(centroid.y).toFixed(1)}
          />
          <line
            x1={xScale(centroid.x).toFixed(1)}
            x2={xScale(centroid.x).toFixed(1)}
            y1={(yScale(centroid.y) - 7).toFixed(1)}
            y2={(yScale(centroid.y) + 7).toFixed(1)}
          />
        </g>
      ) : null}
    </svg>
  );
}
