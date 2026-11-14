import type { ReactNode } from 'react';
import { cx } from './cx';

export type CellAlign = 'left' | 'right' | 'center';

const alignClass: Record<CellAlign, string> = {
  left: 'is-left',
  right: 'is-right',
  center: 'is-center',
};

export interface DataTableColumn<T> {
  /** Field name used by the default cell renderer. */
  key: string;
  label: ReactNode;
  /** Unit shown next to the label, e.g. "m". */
  unit?: ReactNode;
  align?: CellAlign;
  /** Optional CSS width hint for the column (e.g. `"90px"`). */
  width?: string;
  /** Custom cell renderer; overrides the default `row[key]` text. */
  cell?: (row: T, index: number) => ReactNode;
}

export interface DataTableProps<T> {
  columns: ReadonlyArray<DataTableColumn<T>>;
  rows: ReadonlyArray<T>;
  /** Stable key per row (never the array index alone when reordering). */
  rowKey: (row: T, index: number) => string | number;
  /** Accessible table caption (rendered visually hidden by `.sr-only`). */
  caption?: ReactNode;
  /** Footer cells, one entry per column. */
  footer?: ReadonlyArray<ReactNode>;
  /** Rendered instead of the table when there are no rows. */
  empty?: ReactNode;
  className?: string;
  /** Scroll viewport height in px; defaults to the CSS max-height. */
  maxHeight?: number;
  /** Make first column sticky for long station tables. */
  firstColumnSticky?: boolean;
}

/**
 * Dense engineering data table: sticky mono heads, tabular numerals, hairline
 * rows, optional footer totals and an empty state. Composes `.table-wrap` and
 * `.data-table`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  footer,
  empty,
  className,
  maxHeight,
  firstColumnSticky = true,
}: DataTableProps<T>) {
  if (rows.length === 0 && empty) {
    return <div className={cx('table-empty', className)}>{empty}</div>;
  }

  return (
    <div
      className={cx('table-wrap', firstColumnSticky && 'table-wrap--sticky', className)}
      style={maxHeight ? { maxHeight } : undefined}
      tabIndex={0}
      role="region"
      aria-label={typeof caption === 'string' ? caption : undefined}
    >
      <table className="data-table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={alignClass[column.align ?? 'right']}
                style={column.width ? { width: column.width } : undefined}
              >
                {column.label}
                {column.unit ? <span className="field__unit"> {column.unit}</span> : null}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowKey(row, rowIndex)}>
              {columns.map((column, columnIndex) => (
                <td
                  key={column.key}
                  className={cx(
                    alignClass[column.align ?? (columnIndex === 0 ? 'left' : 'right')],
                    columnIndex === 0 && firstColumnSticky && 'is-sticky',
                  )}
                >
                  {column.cell
                    ? column.cell(row, rowIndex)
                    : defaultCell(row, column.key)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer && footer.length > 0 ? (
          <tfoot>
            <tr>
              {footer.map((cell, index) => (
                <td key={columns[index]?.key ?? index} className={alignClass[columns[index]?.align ?? 'right']}>
                  {cell}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}

function defaultCell<T>(row: T, key: string): ReactNode {
  const record = row as unknown as Record<string, unknown>;
  const value = record[key];
  if (value === null || value === undefined || value === '') return '—';
  return String(value);
}
