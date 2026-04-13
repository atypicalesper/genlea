/** Returns a deduplicated array preserving order of first occurrence */
export function uniqueArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

/** Returns the newer of two optional dates; returns the defined one if only one is defined */
export function newerDate(a?: Date, b?: Date): Date | undefined {
  if (!a && !b) return undefined;
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
