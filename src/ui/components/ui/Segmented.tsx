import type { ReactNode } from 'react';
import { cx } from './cx';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  /** Tooltip / accessible clarification. */
  title?: string;
}

export interface SegmentedProps<T extends string> {
  options: ReadonlyArray<SegmentedOption<T>>;
  value: T;
  onChange: (value: T) => void;
  /** Accessible group name; also used as the visible label when `showLabel`. */
  label: string;
  /** Render the group name above the control. */
  showLabel?: boolean;
  className?: string;
  disabled?: boolean;
}

/**
 * Instrument mode switch: a real toggle-button group (`aria-pressed`), keyboard
 * reachable, with the active state rendered from the component layer.
 */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  showLabel = false,
  className,
  disabled = false,
}: SegmentedProps<T>) {
  return (
    <div className={cx('segmented-field', className)}>
      {showLabel ? <span className="segmented-label">{label}</span> : null}
      <div className="segmented" role="group" aria-label={label}>
        {options.map((option) => {
          const active = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              className="segmented__item"
              aria-pressed={active}
              title={option.title}
              disabled={disabled}
              onClick={() => onChange(option.value)}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
