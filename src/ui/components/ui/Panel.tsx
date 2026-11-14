import type { ReactNode } from 'react';
import { useId } from 'react';
import { cx } from './cx';

export interface PanelProps {
  /** Short engineering label, rendered as the panel heading. */
  title?: ReactNode;
  /** Small mono meta line shown at the right of the heading. */
  meta?: ReactNode;
  /** Inline controls shown at the right of the heading. */
  actions?: ReactNode;
  /** Footer strip, rendered under a hairline. */
  footer?: ReactNode;
  /** Tight body padding for dense instrument panels. */
  tight?: boolean;
  className?: string;
  id?: string;
  children?: ReactNode;
}

/**
 * The instrument panel: hairline frame, mono uppercase heading, optional
 * header actions and footer strip. Composes `.panel` from the component layer.
 */
export function Panel({
  title,
  meta,
  actions,
  footer,
  tight = false,
  className,
  id,
  children,
}: PanelProps) {
  const headingId = useId();
  const hasHead = Boolean(title ?? meta ?? actions);

  return (
    <section
      className={cx('panel', className)}
      id={id}
      aria-labelledby={title ? headingId : undefined}
    >
      {hasHead ? (
        <header className="panel__head">
          {title ? (
            <h3 className="panel__title" id={headingId}>
              {title}
            </h3>
          ) : (
            <span className="panel__title" aria-hidden="true" />
          )}
          {meta ? <span className="panel__meta">{meta}</span> : null}
          {actions ? <div className="row row--end">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cx('panel__body', tight && 'panel__body--tight')}>{children}</div>
      {footer ? <footer className="panel__foot">{footer}</footer> : null}
    </section>
  );
}
