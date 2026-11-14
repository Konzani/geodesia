import type { ReactNode } from 'react';
import { cx } from './cx';

export interface FieldProps {
  label: ReactNode;
  /** Id of the bound control — always pass it so the label is clickable. */
  htmlFor?: string;
  /** Unit suffix shown at the right of the label. */
  unit?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Form field: mono uppercase label bound to the control via `htmlFor`, optional
 * unit, hint and error. Error is also exposed as a live region by the caller's
 * control (aria-describedby) when relevant.
 */
export function Field({ label, htmlFor, unit, hint, error, children, className }: FieldProps) {
  return (
    <div className={cx('field', className)}>
      <label className="field__label" htmlFor={htmlFor}>
        <span>{label}</span>
        {unit ? <span className="field__unit">{unit}</span> : null}
      </label>
      {children}
      {error ? (
        <p className="field__error" id={htmlFor ? `${htmlFor}-error` : undefined} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field__hint" id={htmlFor ? `${htmlFor}-hint` : undefined}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}
