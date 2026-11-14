import type { ReactNode } from 'react';
import { cx } from './cx';

export type ReadoutTone = 'default' | 'accent';

export interface ReadoutProps {
  label: ReactNode;
  value: ReactNode;
  /** Unit suffix, styled smaller and muted. */
  unit?: ReactNode;
  /** Secondary line under the value (delta, qualifier, range). */
  delta?: ReactNode;
  tone?: ReadoutTone;
  /** Span two grid tracks on wide layouts. */
  wide?: boolean;
  className?: string;
  /** Full value text for screen readers / tooltips when value is abbreviated. */
  title?: string;
}

/** A single instrument readout: mono label, tabular value, quiet unit. */
export function Readout({
  label,
  value,
  unit,
  delta,
  tone = 'default',
  wide = false,
  className,
  title,
}: ReadoutProps) {
  return (
    <div
      className={cx('readout', tone === 'accent' && 'readout--accent', wide && 'readout--wide', className)}
      title={title}
    >
      <span className="readout__label">{label}</span>
      <span className="readout__value">
        {value}
        {unit ? <small className="readout__unit">{unit}</small> : null}
      </span>
      {delta ? <span className="readout__delta">{delta}</span> : null}
    </div>
  );
}

export interface ReadoutGridProps {
  children: ReactNode;
  /** Accessible group name, e.g. "Profile metrics". */
  label?: string;
  className?: string;
}

/** Hairline-separated grid of `Readout` cells. */
export function ReadoutGrid({ children, label, className }: ReadoutGridProps) {
  return (
    <div className={cx('readouts', className)} role="group" aria-label={label}>
      {children}
    </div>
  );
}
