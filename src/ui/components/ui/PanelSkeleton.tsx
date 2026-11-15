import { cx } from './cx';

export interface PanelSkeletonProps {
  /** Short uppercase label describing what is loading. */
  label?: string;
  /** Number of placeholder lines. */
  rows?: number;
  className?: string;
}

/**
 * Designed loading placeholder for lazy instrument chunks: a real panel frame
 * with hairline skeleton lines, announced as busy. Used by `Workspace` as the
 * Suspense fallback so a lazily loaded tab never flashes a blank panel.
 */
export function PanelSkeleton({ label = 'Loading instrument…', rows = 3, className }: PanelSkeletonProps) {
  return (
    <div className={cx('panel', 'panel-skeleton', className)} aria-busy="true" aria-live="polite">
      <div className="panel__head">
        <span className="panel__title">{label}</span>
      </div>
      <div className="panel__body">
        {Array.from({ length: Math.max(1, rows) }).map((_, index) => (
          <span
            key={`skeleton-${index}`}
            className="skeleton-line"
            style={{ width: `${Math.max(35, 100 - index * 14)}%` }}
          />
        ))}
        <p className="sr-only">{label}</p>
      </div>
    </div>
  );
}
