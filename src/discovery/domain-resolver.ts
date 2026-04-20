import { logger } from '../utils/logger.js';

const _cache = new Map<string, string | null>();

interface ClearbitSuggestion { name: string; domain: string; logo?: string }

export async function resolveNameToDomain(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (_cache.has(key)) return _cache.get(key)!;

  try {
    const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { _cache.set(key, null); return null; }

    const suggestions = await res.json() as ClearbitSuggestion[];
    const best = suggestions.find(s => fuzzyNameMatch(s.name, name)) ?? suggestions[0];
    const domain = best?.domain?.toLowerCase() ?? null;

    _cache.set(key, domain);
    return domain;
  } catch (err) {
    logger.debug({ err, name }, '[domain-resolver] Clearbit autocomplete failed');
    _cache.set(key, null);
    return null;
  }
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}
