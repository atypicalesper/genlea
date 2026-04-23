import type { Scraper, ScrapeQuery, RawResult, RawCompany, RawJob } from '../../types/index.js';
import { duckDuckGoSearch, extractSlugs, extractTechFromTitle } from './ats-search.js';
import { resolveNameToDomain } from '../../discovery/domain-resolver.js';
import { logger } from '../../utils/logger.js';

interface AshbyJob {
  id: string;
  title: string;
  jobUrl?: string;
  publishedDate?: string;
  locationName?: string;
  teamName?: string;
}

interface AshbyResponse {
  jobs?: AshbyJob[];
}

const SLUG_RE = /jobs\.ashbyhq\.com\/([a-z0-9][a-z0-9-]{0,40})(?:\/|$|\?|#)/i;
const API     = (slug: string) => `https://api.ashbyhq.com/posting-api/job-board/${slug}`;

export class AshbyScraper implements Scraper {
  name = 'ashby' as const;

  async isAvailable(): Promise<boolean> { return true; }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const dorked = `site:jobs.ashbyhq.com ${query.keywords}`;
    logger.info({ query: dorked }, '[ashby] Dorking for boards');

    const urls  = await duckDuckGoSearch(dorked, 100);
    const slugs = extractSlugs(urls, SLUG_RE);
    logger.info({ slugs: slugs.length }, '[ashby] Boards discovered');

    const limit   = query.limit ?? 25;
    const results: RawResult[] = [];

    for (const slug of slugs.slice(0, limit)) {
      try {
        const result = await this.fetchBoard(slug);
        if (result) results.push(result);
      } catch (err) {
        logger.debug({ slug, err }, '[ashby] Board fetch failed');
      }
    }

    logger.info({ results: results.length }, '[ashby] Scrape complete');
    return results;
  }

  private async fetchBoard(slug: string): Promise<RawResult | null> {
    const res = await fetch(API(slug), { signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return null;

    const data = await res.json() as AshbyResponse;
    if (!data.jobs?.length) return null;

    const companyName = slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const domain      = await resolveNameToDomain(companyName).catch(() => null);

    const jobs: RawJob[] = data.jobs.slice(0, 30).map(j => ({
      companyDomain: domain ?? '',
      title:         j.title,
      techTags:      extractTechFromTitle(j.title),
      source:        'ashby',
      sourceUrl:     j.jobUrl ?? `https://jobs.ashbyhq.com/${slug}/${j.id}`,
      postedAt:      j.publishedDate ? new Date(j.publishedDate) : undefined,
    }));

    const company: Partial<RawCompany> = {
      name:      companyName,
      domain:    domain ?? undefined,
      hqCountry: 'Unknown',
    };

    return { source: 'ashby', company, jobs, scrapedAt: new Date() };
  }
}

export const ashbyScraper = new AshbyScraper();
