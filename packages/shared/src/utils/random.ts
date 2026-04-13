/** Returns a random integer between min and max (inclusive) */
export function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Returns a random float between min and max */
export function randomBetween(min: number, max: number): number {
  return Math.random() * (max - min) + min;
}

/** Returns a random item from an array */
export function randomPick<T>(arr: T[]): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[randomInt(0, arr.length - 1)];
}

/** Sleep for a random duration between minMs and maxMs */
export function randomSleep(minMs: number, maxMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, randomBetween(minMs, maxMs)));
}

/** Normalize a domain: strip www., lowercase, strip trailing slashes and protocol */
export function normalizeDomain(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]!
    .trim();
}

/** Normalize email: lowercase and trim */
export function normalizeEmail(raw: string): string {
  return raw.toLowerCase().trim();
}

/** Generate a UUID-like run ID */
export function generateRunId(): string {
  return `run_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/** Chunk an array into batches of size n */
export function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}
