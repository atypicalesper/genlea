import type { Scraper, ScrapeQuery, RawResult, RawCompany, RawJob } from '../../types/index.js';
import { duckDuckGoSearch, extractSlugs, extractTechFromTitle } from './ats-search.js';
import { resolveNameToDomain } from '../../discovery/domain-resolver.js';
import { logger } from '../../utils/logger.js';

interface GreenhouseJob {
  id: number;
  title: string;
  absolute_url: string;
  updated_at?: string;
  location?: { name?: string };
}

interface GreenhouseResponse {
  jobs?: GreenhouseJob[];
  meta?: { total?: number };
}

const SLUG_RE = /boards\.greenhouse\.io\/([a-z0-9][a-z0-9-]{0,40})(?:\/|$|\?|#)/i;
const API     = (slug: string) => `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`;
const BOARD   = (slug: string) => `https://boards.greenhouse.io/${slug}`;

export class GreenhouseScraper implements Scraper {
  name = 'greenhouse' as const;

  async isAvailable(): Promise<boolean> { return true; }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const dorked = `site:boards.greenhouse.io ${query.keywords}`;
    logger.info({ query: dorked }, '[greenhouse] Dorking for boards');

    const urls  = await duckDuckGoSearch(dorked, 100);
    const slugs = extractSlugs(urls, SLUG_RE).filter(s => s !== 'embed');
    logger.info({ slugs: slugs.length }, '[greenhouse] Boards discovered');

    const limit   = query.limit ?? 25;
    const results: RawResult[] = [];

    for (const slug of slugs.slice(0, limit)) {
      try {
        const result = await this.fetchBoard(slug);
        if (result) results.push(result);
      } catch (err) {
        logger.debug({ slug, err }, '[greenhouse] Board fetch failed');
      }
    }

    logger.info({ results: results.length }, '[greenhouse] Scrape complete');
    return results;
  }

  private async fetchBoard(slug: string): Promise<RawResult | null> {
    const res = await fetch(API(slug), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;

    const data = await res.json() as GreenhouseResponse;
    if (!data.jobs?.length) return null;

    const companyName = await resolveCompanyName(slug);
    const domain      = await resolveNameToDomain(companyName).catch(() => null);

    const jobs: RawJob[] = data.jobs.slice(0, 30).map(j => ({
      companyDomain: domain ?? '',
      title:         j.title,
      techTags:      extractTechFromTitle(j.title),
      source:        'greenhouse',
      sourceUrl:     j.absolute_url,
      postedAt:      j.updated_at ? new Date(j.updated_at) : undefined,
    }));

    const company: Partial<RawCompany> = {
      name:      companyName,
      domain:    domain ?? undefined,
      hqCountry: 'Unknown',
    };

    return { source: 'greenhouse', company, jobs, scrapedAt: new Date() };
  }
}

async function resolveCompanyName(slug: string): Promise<string> {
  try {
    const res = await fetch(BOARD(slug), { signal: AbortSignal.timeout(6_000) });
    if (res.ok) {
      const html = await res.text();
      const title = html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? '';
      const cleaned = title.replace(/\s*[-|]\s*Greenhouse.*$/i, '').replace(/^careers at\s*/i, '').trim();
      if (cleaned.length > 2 && cleaned.length < 80) return cleaned;
    }
  } catch { /* fall through */ }
  return slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export const greenhouseScraper = new GreenhouseScraper();
