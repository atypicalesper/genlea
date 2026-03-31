import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawJob,
} from '../types/index.js';
import { browserManager } from '../core/browser.manager.js';
import { proxyManager } from '../core/proxy.manager.js';
import { logger } from '../utils/logger.js';
import { generateRunId, randomBetween } from '../utils/random.js';

/**
 * Glassdoor scraper — free job listings + company data.
 * No API key or login required for job search results.
 * Extracts: company name, size, location, open roles, tech tags.
 */
export class GlassdoorScraper implements Scraper {
  name = 'glassdoor' as const;

  async isAvailable(): Promise<boolean> {
    return true; // always available — no auth required
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `glassdoor-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords, limit: query.limit }, '[glassdoor] Starting scrape');

    try {
      const proxy = proxyManager.getProxy();
      const context = await browserManager.createContext(browserId, proxy ? { proxy } : {});
      const page    = await browserManager.newPage(context);

      const listings = await this.searchJobs(page, query);
      logger.info({ found: listings.length }, '[glassdoor] Job listings found');

      // Group listings by company to build RawResult per company
      const byCompany = new Map<string, { company: Partial<RawCompany>; jobs: Partial<RawJob>[] }>();

      for (const listing of listings) {
        const key = listing.companyName.toLowerCase().trim();
        const domain = slugifyName(listing.companyName);
        if (!byCompany.has(key)) {
          byCompany.set(key, {
            company: {
              name:          listing.companyName,
              domain,
              hqCity:        listing.city,
              hqState:       listing.state,
              hqCountry:     'US',
              employeeCount: listing.employeeCount,
              industry:      listing.industry ? [listing.industry] : [],
            },
            jobs: [],
          });
        }
        byCompany.get(key)!.jobs.push({
          companyDomain: domain,
          title:         listing.jobTitle,
          techTags:      listing.techTags,
          source:        'glassdoor',
          postedAt:      listing.postedAt,
        });
      }

      for (const { company, jobs } of byCompany.values()) {
        results.push({
          source:    'glassdoor',
          company,
          contacts:  [],
          jobs,
          scrapedAt: new Date(),
        });
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[glassdoor] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[glassdoor] Scrape complete');
    return results;
  }

  // ── Job search ────────────────────────────────────────────────────────────

  private async searchJobs(page: Page, query: ScrapeQuery): Promise<GlassdoorListing[]> {
    const encoded = encodeURIComponent(query.keywords);
    const url = `https://www.glassdoor.com/Job/jobs.htm?sc.keyword=${encoded}&locT=N&locId=1&jobType=fulltime`;

    logger.debug({ url }, '[glassdoor] Navigating to job search');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 5000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[glassdoor] CAPTCHA detected — returning empty');
      return [];
    }

    // Dismiss sign-up modal if present
    await page.locator('[alt="Close"], button[data-test="modal-close-btn"], .modal_closeButton').first()
      .click().catch(() => {});
    await browserManager.humanDelay(500, 1000);

    await browserManager.humanScroll(page, 4);

    const limit = query.limit ?? 25;
    const listings: GlassdoorListing[] = [];
    let attempts = 0;

    while (listings.length < limit && attempts < 3) {
      const cards = page.locator('[data-test="jobListing"], .react-job-listing, li.JobsList_jobListItem__wjTHv');
      const count = await cards.count();

      for (let i = 0; i < count && listings.length < limit; i++) {
        try {
          const card = cards.nth(i);
          const listing = await this.parseCard(card);
          if (listing) listings.push(listing);
        } catch (err) {
          logger.debug({ err }, '[glassdoor] Card parse error — skipping');
        }
      }

      // Try to load more results
      const moreBtn = page.locator('button[data-test="load-more"], .JobsList_buttonWrapper__ticwb button').first();
      const hasMore = await moreBtn.isVisible().catch(() => false);
      if (!hasMore || listings.length >= limit) break;

      await moreBtn.click().catch(() => {});
      await browserManager.humanDelay(2000, 4000);
      attempts++;
    }

    return listings;
  }

  private async parseCard(card: ReturnType<Page['locator']>): Promise<GlassdoorListing | null> {
    const jobTitleEl   = card.locator('[data-test="job-title"], .JobCard_jobTitle__GLyJ1, a.jobTitle').first();
    const companyEl    = card.locator('[data-test="employer-name"], .EmployerProfile_compactEmployerName__9MGcV, .JobCard_employer__N7e3O').first();
    const locationEl   = card.locator('[data-test="emp-location"], .JobCard_location__rCz3x, .location').first();
    const salaryEl     = card.locator('[data-test="detailSalary"], .JobCard_salaryEstimate__arV5J').first();
    const sizeEl       = card.locator('.employerSize, [data-test="employer-size"]').first();

    const jobTitle   = ((await jobTitleEl.textContent().catch(() => '')) ?? '').trim();
    const companyName = ((await companyEl.textContent().catch(() => '')) ?? '').trim();
    const location   = ((await locationEl.textContent().catch(() => '')) ?? '').trim();

    if (!jobTitle || !companyName) return null;
    if (!isUSLocation(location)) return null;

    const sizeText = ((await sizeEl.textContent().catch(() => '')) ?? '').trim();
    const salaryText = ((await salaryEl.textContent().catch(() => '')) ?? '').trim();

    const { city, state } = parseLocation(location);

    return {
      jobTitle,
      companyName,
      city,
      state,
      employeeCount: parseEmployeeCount(sizeText),
      industry:      '',
      techTags:      extractTechTags(jobTitle + ' ' + salaryText),
      postedAt:      new Date(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugifyName(name: string): string {
  return name.toLowerCase()
    .replace(/\s+(inc|llc|ltd|corp|co\.?)\.?$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) + '.com';
}

interface GlassdoorListing {
  jobTitle:      string;
  companyName:   string;
  city:          string;
  state:         string;
  employeeCount: number | undefined;
  industry:      string;
  techTags:      string[];
  postedAt:      Date;
}

function isUSLocation(location: string): boolean {
  // Accept "City, ST" patterns and "United States" / "Remote"
  return /,\s*[A-Z]{2}$/.test(location.trim())
    || /united states/i.test(location)
    || /remote/i.test(location);
}

function parseLocation(location: string): { city: string; state: string } {
  const match = location.match(/^(.+),\s*([A-Z]{2})$/);
  if (match) return { city: match[1]!.trim(), state: match[2]! };
  return { city: '', state: '' };
}

function parseEmployeeCount(text: string): number | undefined {
  const match = text.match(/(\d[\d,]*)\s*[-–to]+\s*(\d[\d,]*)/);
  if (match) {
    const lo = parseInt(match[1]!.replace(/,/g, ''));
    const hi = parseInt(match[2]!.replace(/,/g, ''));
    return Math.round((lo + hi) / 2);
  }
  return undefined;
}

const TECH_KEYWORDS: Record<string, string> = {
  'node': 'nodejs', 'node.js': 'nodejs', 'react': 'react', 'next.js': 'nextjs',
  'nextjs': 'nextjs', 'python': 'python', 'typescript': 'typescript', 'ts': 'typescript',
  'fastapi': 'fastapi', 'nestjs': 'nestjs', 'graphql': 'graphql', 'postgres': 'postgresql',
  'mongodb': 'mongodb', 'aws': 'aws', 'gcp': 'gcp', 'azure': 'azure', 'docker': 'docker',
  'kubernetes': 'kubernetes', 'k8s': 'kubernetes', 'llm': 'ai', 'ai': 'ai', 'ml': 'ml',
  'machine learning': 'ml', 'generative': 'generative-ai', 'langchain': 'ai',
};

function extractTechTags(text: string): string[] {
  const lower = text.toLowerCase();
  const found = new Set<string>();
  for (const [keyword, tag] of Object.entries(TECH_KEYWORDS)) {
    if (lower.includes(keyword)) found.add(tag);
  }
  return [...found];
}

export const glassdoorScraper = new GlassdoorScraper();
