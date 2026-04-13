export function uniqueArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

export function newerDate(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
