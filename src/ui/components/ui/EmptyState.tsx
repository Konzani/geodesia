import type { ReactNode } from 'react';
import { cx } from './cx';

export interface EmptyStateProps {
  title: ReactNode;
  children?: ReactNode;
  /** Decorative geometric glyph (an icon component instance). */
  icon?: ReactNode;
  action?: ReactNode;
  className?: string;
}

/** Designed empty state: dashed plate, quiet title, one line of next action. */
export function EmptyState({ title, children, icon, action, className }: EmptyStateProps) {
  return (
    <div className={cx('empty', className)}>
      {icon ? (
        <span className="empty__icon" aria-hidden="true">
          {icon}
        </span>
      ) : null}
      <p className="empty__title">{title}</p>
      {children ? <p className="empty__text">{children}</p> : null}
      {action ? <div className="empty__action">{action}</div> : null}
    </div>
  );
}
