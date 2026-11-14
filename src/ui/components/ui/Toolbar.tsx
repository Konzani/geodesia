import type { ReactNode } from 'react';
import { cx } from './cx';

export interface ToolbarProps {
  children: ReactNode;
  /** Accessible name for the control cluster. */
  label?: string;
  /** Push the last group to the far edge. */
  between?: boolean;
  className?: string;
}

/** Horizontal cluster of tool controls (buttons, segmented switch, status). */
export function Toolbar({ children, label, between = false, className }: ToolbarProps) {
  return (
    <div
      className={cx('row', between && 'row--between', 'toolbar', className)}
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
