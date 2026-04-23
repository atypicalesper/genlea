import type { Scraper, ScrapeQuery, RawResult, RawCompany, RawJob } from '../../types/index.js';
import { duckDuckGoSearch, extractSlugs, extractTechFromTitle } from './ats-search.js';
import { resolveNameToDomain } from '../../discovery/domain-resolver.js';
import { logger } from '../../utils/logger.js';

interface LeverPosting {
  id: string;
  text: string;
  hostedUrl: string;
  createdAt?: number;
  categories?: { team?: string; location?: string; commitment?: string };
}

const SLUG_RE = /jobs\.lever\.co\/([a-z0-9][a-z0-9-]{0,40})(?:\/|$|\?|#)/i;
const API     = (slug: string) => `https://api.lever.co/v0/postings/${slug}?mode=json`;

export class LeverScraper implements Scraper {
  name = 'lever' as const;

  async isAvailable(): Promise<boolean> { return true; }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const dorked = `site:jobs.lever.co ${query.keywords}`;
    logger.info({ query: dorked }, '[lever] Dorking for boards');

    const urls  = await duckDuckGoSearch(dorked, 100);
    const slugs = extractSlugs(urls, SLUG_RE);
    logger.info({ slugs: slugs.length }, '[lever] Boards discovered');

    const limit   = query.limit ?? 25;
    const results: RawResult[] = [];

    for (const slug of slugs.slice(0, limit)) {
      try {
        const result = await this.fetchBoard(slug);
        if (result) results.push(result);
      } catch (err) {
        logger.debug({ slug, err }, '[lever] Board fetch failed');
      }
    }

    logger.info({ results: results.length }, '[lever] Scrape complete');
    return results;
  }

  private async fetchBoard(slug: string): Promise<RawResult | null> {
    const res = await fetch(API(slug), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;

    const postings = await res.json() as LeverPosting[];
    if (!Array.isArray(postings) || !postings.length) return null;

    const companyName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const domain      = await resolveNameToDomain(companyName).catch(() => null);

    const jobs: RawJob[] = postings.slice(0, 30).map(j => ({
      companyDomain: domain ?? '',
      title:         j.text,
      techTags:      extractTechFromTitle(j.text),
      source:        'lever',
      sourceUrl:     j.hostedUrl,
      postedAt:      j.createdAt ? new Date(j.createdAt) : undefined,
    }));

    const company: Partial<RawCompany> = {
      name:      companyName,
      domain:    domain ?? undefined,
      hqCountry: 'Unknown',
    };

    return { source: 'lever', company, jobs, scrapedAt: new Date() };
  }
}

export const leverScraper = new LeverScraper();
