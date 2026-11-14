/** Class-name composition shared by the UI primitives and instrument tools. */
export function cx(...values: Array<string | false | null | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).join(' ');
}
