import type { Scraper, ScrapeQuery, RawResult, RawCompany, RawJob } from '../../types/index.js';
import { duckDuckGoSearch, extractSlugs, extractTechFromTitle } from './ats-search.js';
import { resolveNameToDomain } from '../../discovery/domain-resolver.js';
import { logger } from '../../utils/logger.js';

interface WorkableJob {
  id: string;
  shortcode?: string;
  title: string;
  url?: string;
  published_on?: string;
  location?: { city?: string; country?: string };
}

interface WorkableResponse {
  jobs?: WorkableJob[];
  name?: string;
  description?: string;
}

const SLUG_RE = /apply\.workable\.com\/([a-z0-9][a-z0-9-]{0,40})(?:\/|$|\?|#)/i;
const API     = (slug: string) => `https://apply.workable.com/api/v3/accounts/${slug}/jobs`;

export class WorkableScraper implements Scraper {
  name = 'workable' as const;

  async isAvailable(): Promise<boolean> { return true; }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const dorked = `site:apply.workable.com ${query.keywords}`;
    logger.info({ query: dorked }, '[workable] Dorking for boards');

    const urls  = await duckDuckGoSearch(dorked, 100);
    const slugs = extractSlugs(urls, SLUG_RE).filter(s => s !== 'j');
    logger.info({ slugs: slugs.length }, '[workable] Boards discovered');

    const limit   = query.limit ?? 25;
    const results: RawResult[] = [];

    for (const slug of slugs.slice(0, limit)) {
      try {
        const result = await this.fetchBoard(slug);
        if (result) results.push(result);
      } catch (err) {
        logger.debug({ slug, err }, '[workable] Board fetch failed');
      }
    }

    logger.info({ results: results.length }, '[workable] Scrape complete');
    return results;
  }

  private async fetchBoard(slug: string): Promise<RawResult | null> {
    const res = await fetch(API(slug), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'accept': 'application/json' },
      body:   JSON.stringify({}),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) return null;

    const data = await res.json() as WorkableResponse;
    if (!data.jobs?.length) return null;

    const companyName = data.name?.trim() || slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const domain      = await resolveNameToDomain(companyName).catch(() => null);

    const jobs: RawJob[] = data.jobs.slice(0, 30).map(j => ({
      companyDomain: domain ?? '',
      title:         j.title,
      techTags:      extractTechFromTitle(j.title),
      source:        'workable',
      sourceUrl:     j.url ?? `https://apply.workable.com/${slug}/j/${j.shortcode ?? j.id}`,
      postedAt:      j.published_on ? new Date(j.published_on) : undefined,
    }));

    const company: Partial<RawCompany> = {
      name:      companyName,
      domain:    domain ?? undefined,
      hqCountry: 'US',
    };

    return { source: 'workable', company, jobs, scrapedAt: new Date() };
  }
}

export const workableScraper = new WorkableScraper();
