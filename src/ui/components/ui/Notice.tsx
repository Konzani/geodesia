import type { ReactNode } from 'react';
import { cx } from './cx';

export type NoticeTone = 'info' | 'warn' | 'err' | 'ok' | 'default';

export interface NoticeProps {
  children: ReactNode;
  /** Optional bold lead-in. */
  title?: ReactNode;
  tone?: NoticeTone;
  /** Override the default glyph. */
  icon?: ReactNode;
  /** Inline action(s), e.g. a Retry button. */
  action?: ReactNode;
  /** Announce the notice when it appears (default: assertive for errors). */
  live?: 'polite' | 'assertive' | false;
  className?: string;
}

const glyphs: Record<NoticeTone, string> = {
  info: 'i',
  warn: '!',
  err: '!',
  ok: '✓',
  default: '·',
};

/**
 * Inline engineering notice. Errors are announced assertively so a failed
 * elevation fetch or invalid polygon is not a silent dead end.
 */
export function Notice({
  children,
  title,
  tone = 'default',
  icon,
  action,
  live,
  className,
}: NoticeProps) {
  const assertive = live === 'assertive' || (live !== false && tone === 'err');
  const role = live === false ? undefined : assertive ? 'alert' : 'status';
  const ariaLive = live === false ? undefined : assertive ? 'assertive' : 'polite';

  return (
    <div
      className={cx('notice', tone !== 'default' && `notice--${tone}`, className)}
      role={role}
      aria-live={ariaLive}
    >
      <span className="notice__icon" aria-hidden="true">
        {icon ?? glyphs[tone]}
      </span>
      <div className="notice__body">
        {title ? <strong className="notice__title">{title}</strong> : null}
        <div className="notice__text">{children}</div>
        {action ? <div className="notice__action">{action}</div> : null}
      </div>
    </div>
  );
}
