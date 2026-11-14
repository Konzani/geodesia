/**
 * GEODESIA — ecosystem hub directory with accessible filtering.
 *
 * The three cards are owned by this component and are server-rendered by Astro
 * (an island's initial HTML is SSR'd), then hydrated so the filter chips work.
 * No `window` at module scope; the filtering state starts at "all" so the
 * server output and the first client render agree.
 *
 * Page usage: `<HubFilter client:visible />` (or `client:load`).
 */
import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import '../styles/tools.css';
import { fmtNumber } from '../../math';
import { Badge } from '../components/ui';
import { IconFlow, IconLayers, IconTerrain } from '../tools/icons';
import { cx } from '../tools/utils';

export type HubFilterId = 'all' | 'live' | 'beta' | 'client';
export type HubAppStatus = 'live' | 'beta';

export interface HubApp {
  id: string;
  name: string;
  host: string;
  description: string;
  /** One line of technical specifics. */
  technical: string;
  statuses: ReadonlyArray<HubAppStatus>;
  clientSide: boolean;
  core?: boolean;
  cta: string;
  href: string;
  external: boolean;
  tags: ReadonlyArray<string>;
  icon: ReactNode;
}

export interface HubFilterProps {
  className?: string;
}

const APPS: ReadonlyArray<HubApp> = [
  {
    id: 'core',
    name: 'Geodesia Core',
    host: 'geodesia.online',
    description:
      'Terrain profiles, polygon area and closure, and land-unit conversion in one client-side workspace.',
    technical:
      'WGS 84 geodesic inverse (Karney) · hand-rolled SVG profile chart · CSV / JSON / PDF reports',
    statuses: ['live'],
    clientSide: true,
    core: true,
    cta: 'Open workspace',
    href: '/terrain-profile',
    external: false,
    tags: ['Terrain profile', 'Polygon area', 'Land converter'],
    icon: <IconTerrain size={19} />,
  },
  {
    id: 'landiq',
    name: 'TerraFact',
    host: 'landiq.geodesia.online',
    description:
      'AI crop-suitability analysis (published as Land IQ) over browser-local Cloud-Optimized GeoTIFFs, clipped to a drawn parcel.',
    technical:
      'COGs read in the browser · polygon clipping · no raster upload · suitability scoring',
    statuses: ['beta'],
    clientSide: true,
    cta: 'Open TerraFact',
    href: 'https://landiq.geodesia.online',
    external: true,
    tags: ['Crop suitability', 'Browser-local COGs', 'Parcel clipping'],
    icon: <IconLayers size={19} />,
  },
  {
    id: 'methodflow',
    name: 'MethodFlow',
    host: 'methodflow.geodesia.online',
    description:
      'Thesis methodology flowchart generator for research protocols, exporting publication-ready diagrams.',
    technical: 'LaTeX / TikZ · Word DOCX · Mermaid · deterministic layout',
    statuses: ['live'],
    clientSide: true,
    cta: 'Open MethodFlow',
    href: 'https://methodflow.geodesia.online',
    external: true,
    tags: ['Methodology flows', 'LaTeX/TikZ', 'Word export'],
    icon: <IconFlow size={19} />,
  },
];

const FILTERS: ReadonlyArray<{ id: HubFilterId; label: string; description: string }> = [
  { id: 'all', label: 'All', description: 'every application' },
  { id: 'live', label: 'Live', description: 'live applications' },
  { id: 'beta', label: 'Beta', description: 'beta applications' },
  { id: 'client', label: 'Client-side', description: 'client-side execution' },
];

function matches(app: HubApp, filter: HubFilterId): boolean {
  if (filter === 'all') return true;
  if (filter === 'client') return app.clientSide;
  return app.statuses.includes(filter);
}

const statusLabel: Record<HubAppStatus, string> = {
  live: 'LIVE',
  beta: 'BETA',
};

export default function HubFilter({ className }: HubFilterProps) {
  const [filter, setFilter] = useState<HubFilterId>('all');

  const counts = useMemo<Record<HubFilterId, number>>(
    () => ({
      all: APPS.filter((app) => matches(app, 'all')).length,
      live: APPS.filter((app) => matches(app, 'live')).length,
      beta: APPS.filter((app) => matches(app, 'beta')).length,
      client: APPS.filter((app) => matches(app, 'client')).length,
    }),
    [],
  );

  const visible = useMemo(() => APPS.filter((app) => matches(app, filter)), [filter]);
  const activeFilter = FILTERS.find((entry) => entry.id === filter);

  return (
    <div className={cx('hub-filter', className)}>
      <div className="hub__head">
        <div className="filter-bar" role="group" aria-label="Filter applications">
          {FILTERS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="chip"
              aria-pressed={filter === entry.id}
              aria-label={`${entry.label}: ${fmtNumber(counts[entry.id], 0)} application${counts[entry.id] === 1 ? '' : 's'}`}
              onClick={() => setFilter(entry.id)}
            >
              {entry.label}
              <span className="chip__count" aria-hidden="true">
                {counts[entry.id]}
              </span>
            </button>
          ))}
        </div>
        <p className="sr-only" aria-live="polite">
          {`Showing ${fmtNumber(visible.length, 0)} of ${fmtNumber(counts.all, 0)} applications${
            activeFilter && filter !== 'all' ? ` filtered to ${activeFilter.description}` : ''
          }.`}
        </p>
      </div>

      <ul className="app-grid">
        {visible.map((app) => (
          <li key={app.id} className={cx('app-card', app.core && 'app-card--core')}>
            <div className="app-card__top">
              <div>
                <h3 className="app-card__title">{app.name}</h3>
                <span className="app-card__host">{app.host}</span>
              </div>
              <span className="app-card__icon" aria-hidden="true">
                {app.icon}
              </span>
            </div>

            <div className="app-card__badges">
              {app.statuses.map((status) => (
                <Badge key={status} tone={status === 'live' ? 'live' : 'beta'}>
                  {statusLabel[status]}
                </Badge>
              ))}
              {app.clientSide ? <Badge tone="client">Client-Side Execution</Badge> : null}
            </div>

            <p className="app-card__desc">{app.description}</p>
            <p className="app-card__technical">{app.technical}</p>

            <ul className="app-card__tags">
              {app.tags.map((tag) => (
                <li key={tag}>{tag}</li>
              ))}
            </ul>

            <div className="app-card__foot">
              <a
                className="launch-link"
                href={app.href}
                {...(app.external ? { target: '_blank', rel: 'noopener noreferrer' } : {})}
              >
                {app.cta}
                {app.external ? <span className="sr-only"> (opens in a new tab)</span> : null}
              </a>
              <span className="app-card__status-note">
                {app.clientSide ? 'Runs in your browser' : 'Hosted app'}
              </span>
            </div>
          </li>
        ))}
      </ul>

      {visible.length === 0 ? (
        <div className="empty">
          <p className="empty__title">No applications match this filter</p>
          <p className="empty__text">Choose another status or clear the filter to see every app.</p>
          <button type="button" className="btn btn--sm" onClick={() => setFilter('all')}>
            Show all applications
          </button>
        </div>
      ) : null}
    </div>
  );
}
