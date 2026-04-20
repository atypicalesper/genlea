import { logger } from '../utils/logger.js';
import { normalizeDomain } from '../utils/random.js';

const _cache = new Map<string, string | null>();
const _urlCache = new Map<string, string | null>();
const NON_COMPANY_HOSTS = new Set([
  'indeed.com',
  'glassdoor.com',
  'linkedin.com',
  'wellfound.com',
  'crunchbase.com',
  'greenhouse.io',
  'lever.co',
  'ashbyhq.com',
  'workable.com',
  'google.com',
  'facebook.com',
  'x.com',
  'twitter.com',
  'instagram.com',
  'youtube.com',
]);

interface ClearbitSuggestion { name: string; domain: string; logo?: string }

export async function resolveNameToDomain(name: string): Promise<string | null> {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  // Name resolution is a hot path in discovery, so cache misses aggressively to avoid repeated network calls.
  if (_cache.has(key)) return _cache.get(key)!;

  try {
    const url = `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(name)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) { _cache.set(key, null); return null; }

    const suggestions = await res.json() as ClearbitSuggestion[];
    // Prefer close name matches, but fall back to the top suggestion rather than failing closed.
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

export async function resolveDomainFromHintUrls(urls: string[]): Promise<string | null> {
  const candidates = [...new Set(urls.map(u => u.trim()).filter(Boolean))].slice(0, 4);
  for (const url of candidates) {
    const direct = extractCompanyDomain(url);
    if (direct) return direct;
  }

  for (const url of candidates) {
    if (_urlCache.has(url)) return _urlCache.get(url)!;
    try {
      const res = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': 'Mozilla/5.0 GenLeaBot/1.0' },
      });
      if (!res.ok) {
        _urlCache.set(url, null);
        continue;
      }

      const html = await res.text();
      const found = extractDomainFromHtml(html);
      _urlCache.set(url, found);
      if (found) return found;
    } catch (err) {
      logger.debug({ err, url }, '[domain-resolver] URL hint fetch failed');
      _urlCache.set(url, null);
    }
  }

  return null;
}

function extractDomainFromHtml(html: string): string | null {
  const urlMatches = html.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const raw of urlMatches) {
    const domain = extractCompanyDomain(raw);
    if (domain) return domain;
  }

  const emailMatches = html.match(/[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})/gi) ?? [];
  for (const email of emailMatches) {
    const domain = normalizeDomain(email.split('@')[1] ?? '');
    if (isUsableCompanyDomain(domain)) return domain;
  }

  return null;
}

function extractCompanyDomain(rawUrl: string): string | null {
  try {
    const prefixed = /^[a-z]+:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const url = new URL(prefixed);
    const domain = normalizeDomain(url.hostname);
    return isUsableCompanyDomain(domain) ? domain : null;
  } catch {
    return null;
  }
}

function isUsableCompanyDomain(domain: string): boolean {
  if (!domain || !domain.includes('.') || domain.endsWith('.unresolved')) return false;
  return ![...NON_COMPANY_HOSTS].some(host => domain === host || domain.endsWith(`.${host}`));
}

function fuzzyNameMatch(a: string, b: string): boolean {
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = normalize(a);
  const nb = normalize(b);
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}
