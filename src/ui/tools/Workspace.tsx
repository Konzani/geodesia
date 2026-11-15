/**
 * GEODESIA — instrument workspace shell.
 *
 * The single island mounted by every page: a real WAI-ARIA tablist with roving
 * tabindex, arrow/Home/End keyboard navigation, optional URL-hash deep links.
 *
 * Bundle shape: Terrain Profile is statically imported (default tab, SSR'd and
 * immediately interactive); Polygon and Converter are `React.lazy` chunks that
 * are only requested when their tab is first opened (or after hydration when a
 * page passes `initialTab`), with a designed PanelSkeleton and an error
 * boundary + retry if the chunk download fails. No `window` in the factories.
 */
import { Suspense, lazy, useEffect, useRef, useState } from 'react';
import type { ComponentType, KeyboardEvent } from 'react';
import '../styles/tools.css';
import { PanelSkeleton } from '../components/ui';
import TerrainTool from './TerrainTool';
import { ToolChunkBoundary } from './ToolChunkBoundary';
import { IconGrid, IconPolygon, IconTerrain } from './icons';

export type WorkspaceTab = 'terrain' | 'polygon' | 'converter';

export interface WorkspaceProps {
  /** Tab shown before any URL hash is applied. Defaults to `terrain`. */
  initialTab?: WorkspaceTab;
}

interface TabDefinition {
  id: WorkspaceTab;
  label: string;
  index: string;
}

const TABS: ReadonlyArray<TabDefinition> = [
  { id: 'terrain', label: 'Terrain profile', index: '01' },
  { id: 'polygon', label: 'Polygon area', index: '02' },
  { id: 'converter', label: 'Land converter', index: '03' },
];

/** Lazy factories must stay pure: no window/document access inside them. */
const createPolygonLoader = (): ComponentType => lazy(() => import('./PolygonTool'));
const createConverterLoader = (): ComponentType => lazy(() => import('./ConverterTool'));

function isWorkspaceTab(value: string): value is WorkspaceTab {
  return TABS.some((tab) => tab.id === value);
}

export default function Workspace({ initialTab = 'terrain' }: WorkspaceProps) {
  const [active, setActive] = useState<WorkspaceTab>(initialTab);
  // Instruments mount on first use (state is kept after that), so hidden tabs
  // never initialise a Leaflet map or fetch anything before they are opened.
  const [mounted, setMounted] = useState<ReadonlyArray<WorkspaceTab>>([initialTab]);
  // Lazy component refs are regenerated on retry so a rejected import promise
  // is not cached forever.
  const [polygonTool, setPolygonTool] = useState<ComponentType>(createPolygonLoader);
  const [converterTool, setConverterTool] = useState<ComponentType>(createConverterLoader);
  // Render tool chunks only after hydration: SSR never suspends on a lazy
  // module, and server markup (skeleton) matches the first client render.
  const [hydrated, setHydrated] = useState(false);
  const tabRefs = useRef<Partial<Record<WorkspaceTab, HTMLButtonElement | null>>>({});

  useEffect(() => {
    setHydrated(true);
  }, []);

  const ensureMounted = (tab: WorkspaceTab) => {
    setMounted((previous) => (previous.includes(tab) ? previous : [...previous, tab]));
  };

  // Deep link: #terrain / #polygon / #converter, kept in sync both ways.
  useEffect(() => {
    const readHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (isWorkspaceTab(hash)) {
        setActive(hash);
        setMounted((previous) => (previous.includes(hash) ? previous : [...previous, hash]));
      }
    };
    readHash();
    window.addEventListener('hashchange', readHash);
    return () => window.removeEventListener('hashchange', readHash);
  }, []);

  const selectTab = (tab: WorkspaceTab) => {
    ensureMounted(tab);
    setActive(tab);
    tabRefs.current[tab]?.focus();
    if (typeof window !== 'undefined') {
      const nextUrl = `${window.location.pathname}${window.location.search}#${tab}`;
      window.history.replaceState(null, '', nextUrl);
    }
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const currentIndex = TABS.findIndex((tab) => tab.id === active);
    if (currentIndex < 0) return;
    let nextIndex: number | null = null;
    switch (event.key) {
      case 'ArrowRight':
        nextIndex = (currentIndex + 1) % TABS.length;
        break;
      case 'ArrowLeft':
        nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
        break;
      case 'Home':
        nextIndex = 0;
        break;
      case 'End':
        nextIndex = TABS.length - 1;
        break;
      default:
        break;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    const next = TABS[nextIndex];
    if (next) selectTab(next.id);
  };

  const tabId = (tab: WorkspaceTab) => `workspace-tab-${tab}`;
  const panelId = (tab: WorkspaceTab) => `workspace-panel-${tab}`;

  const activeLabel = TABS.find((tab) => tab.id === active)?.label ?? '';

  // Capitalised aliases so JSX treats the lazy loaders as components.
  const PolygonToolLazy = polygonTool;
  const ConverterToolLazy = converterTool;

  return (
    <div className="workspace__frame" data-active-tab={active}>
      <div className="workspace__topbar">
        <div className="tabs" role="tablist" aria-label="Survey instruments" aria-orientation="horizontal">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              ref={(element) => {
                tabRefs.current[tab.id] = element;
              }}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              className="tab"
              aria-selected={active === tab.id}
              aria-controls={panelId(tab.id)}
              tabIndex={active === tab.id ? 0 : -1}
              onClick={() => selectTab(tab.id)}
              onKeyDown={handleTabKeyDown}
            >
              {tab.id === 'terrain' ? (
                <IconTerrain size={15} />
              ) : tab.id === 'polygon' ? (
                <IconPolygon size={15} />
              ) : (
                <IconGrid size={15} />
              )}
              {tab.label}
              <span className="tab__key" aria-hidden="true">
                {tab.index}
              </span>
            </button>
          ))}
        </div>
        <div className="workspace__status">
          <span>{activeLabel}</span>
          <span aria-hidden="true">·</span>
          <span>WGS 84</span>
          <span aria-hidden="true">·</span>
          <span>Client-side</span>
        </div>
      </div>

      {TABS.map((tab) => (
        <div
          key={tab.id}
          id={panelId(tab.id)}
          role="tabpanel"
          aria-labelledby={tabId(tab.id)}
          className="tab-panel"
          tabIndex={0}
          hidden={active !== tab.id}
        >
          {mounted.includes(tab.id) ? (
            <>
              {tab.id === 'terrain' ? <TerrainTool /> : null}
              {tab.id === 'polygon' ? (
                hydrated ? (
                  <ToolChunkBoundary
                    label="Polygon area"
                    onRetry={() => setPolygonTool(createPolygonLoader())}
                  >
                    <Suspense fallback={<PanelSkeleton label="Loading polygon engine…" rows={4} />}>
                      <PolygonToolLazy />
                    </Suspense>
                  </ToolChunkBoundary>
                ) : (
                  <PanelSkeleton label="Loading polygon engine…" rows={4} />
                )
              ) : null}
              {tab.id === 'converter' ? (
                hydrated ? (
                  <ToolChunkBoundary
                    label="Land converter"
                    onRetry={() => setConverterTool(createConverterLoader())}
                  >
                    <Suspense fallback={<PanelSkeleton label="Loading land converter…" rows={3} />}>
                      <ConverterToolLazy />
                    </Suspense>
                  </ToolChunkBoundary>
                ) : (
                  <PanelSkeleton label="Loading land converter…" rows={3} />
                )
              ) : null}
            </>
          ) : null}
        </div>
      ))}
    </div>
  );
}
