import type { ReactNode } from 'react';
import { cx } from './cx';

export type BadgeTone = 'default' | 'live' | 'beta' | 'client';

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  /** Show the leading status dot (default true). */
  dot?: boolean;
  className?: string;
  title?: string;
}

/** Small mono uppercase status chip: LIVE, BETA, CORE, client-side execution. */
export function Badge({ children, tone = 'default', dot = true, className, title }: BadgeProps) {
  return (
    <span
      className={cx(
        'badge',
        tone !== 'default' && `badge--${tone}`,
        !dot && 'badge--plain',
        className,
      )}
      title={title}
    >
      {children}
    </span>
  );
}
