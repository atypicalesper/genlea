import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawJob,
} from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { proxyManager } from '../../core/proxy.manager.js';
import { logger } from '../../utils/logger.js';
import { generateRunId } from '../../utils/random.js';

/**
 * Indeed scraper — free job listings.
 * No login required. Great for detecting active hiring per tech stack.
 * Data extracted: job title, company name, location, posting date, tech tags.
 */
export class IndeedScraper implements Scraper {
  name = 'indeed' as const;

  async isAvailable(): Promise<boolean> {
    return true; // always available — no auth required
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `indeed-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords, limit: query.limit }, '[indeed] Starting scrape');

    try {
      const proxy = proxyManager.getProxy();
      const contextOpts = proxy ? { proxy } : {};
      const context = await browserManager.createContext(browserId, contextOpts);
      const page = await browserManager.newPage(context);

      const jobGroups = await this.searchJobs(page, query);
      logger.info({ companies: jobGroups.size }, '[indeed] Unique companies found');

      for (const [companyName, jobs] of jobGroups) {
        const domain = slugifyName(companyName);
        const rawCompany: Partial<RawCompany> = {
          name:      companyName,
          domain,
          hqCountry: 'US',
        };

        results.push({
          source: 'indeed',
          company: rawCompany,
          jobs,
          scrapedAt: new Date(),
        });
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[indeed] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[indeed] Scrape complete');
    return results;
  }

  private async searchJobs(
    page: Page,
    query: ScrapeQuery
  ): Promise<Map<string, RawJob[]>> {
    // Build URL — Indeed job search for US, sorted by date
    const q = encodeURIComponent(query.keywords);
    const url = `https://www.indeed.com/jobs?q=${q}&l=United+States&sort=date&radius=0&fromage=14`;

    logger.debug({ url }, '[indeed:search] Navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 5000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[indeed:search] CAPTCHA detected on search page');
      return new Map();
    }

    await browserManager.humanScroll(page, 4);

    // Paginate through up to 3 pages
    const jobGroups = new Map<string, RawJob[]>();
    const limit = query.limit ?? 50;

    for (let p = 0; p < 3; p++) {
      const cards = await page.$$('[class*="job_seen_beacon"], [data-testid="job-title"]');
      logger.debug({ page: p + 1, cards: cards.length }, '[indeed:search] Job cards found');

      for (const card of cards) {
        if ([...jobGroups.values()].flat().length >= limit) break;

        try {
          const titleEl    = await card.$('[class*="jobTitle"], h2 a, [data-testid="job-title"]');
          const companyEl  = await card.$('[class*="companyName"], [data-testid="company-name"]');
          const locationEl = await card.$('[class*="companyLocation"], [data-testid="job-location"]');
          const dateEl     = await card.$('[class*="date"], [data-testid="myJobsStateDate"]');

          const title       = (await titleEl?.textContent())?.trim();
          const companyName = (await companyEl?.textContent())?.trim();
          const location    = (await locationEl?.textContent())?.trim() ?? '';
          const dateText    = (await dateEl?.textContent())?.trim() ?? '';

          if (!title || !companyName) continue;

          const techTags = extractTechFromTitle(title);
          const postedAt = parsePostedDate(dateText);

          const job: RawJob = {
            companyDomain: slugifyName(companyName),
            title,
            techTags,
            source:    'indeed',
            sourceUrl: undefined,
            postedAt,
          };

          if (!jobGroups.has(companyName)) jobGroups.set(companyName, []);
          jobGroups.get(companyName)!.push(job);

        } catch (err) {
          logger.debug({ err }, '[indeed:search] Card parse error');
        }
      }

      if ([...jobGroups.values()].flat().length >= limit) break;

      // Click "Next page"
      const nextBtn = await page.$('[aria-label="Next Page"], [data-testid="pagination-page-next"]');
      if (!nextBtn) break;

      logger.debug({ page: p + 2 }, '[indeed:search] Navigating to next page');
      await nextBtn.click();
      await browserManager.humanDelay(2500, 5000);
      await browserManager.humanScroll(page, 3);
    }

    return jobGroups;
  }
}

function slugifyName(name: string): string {
  return name.toLowerCase()
    .replace(/\s+(inc|llc|ltd|corp|co\.?)\.?$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) + '.com';
}

function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'], [/react(?!.?native)/i, 'react'],
    [/react native/i, 'react-native'], [/next\.?js/i, 'nextjs'],
    [/nest\.?js/i, 'nestjs'], [/python/i, 'python'],
    [/typescript/i, 'typescript'], [/frontend|front.end/i, 'frontend'],
    [/backend|back.end/i, 'backend'], [/fullstack|full.stack/i, 'fullstack'],
    [/machine learning|ml engineer/i, 'ml'],
    [/ai engineer|generative ai|llm/i, 'generative-ai'],
    [/fastapi|django|flask/i, 'python'], [/graphql/i, 'graphql'],
    [/golang|go\b/i, 'golang'], [/java\b/i, 'java'],
    [/swift|ios/i, 'ios'], [/android|kotlin/i, 'android'],
    [/devops|sre|platform engineer/i, 'devops'],
    [/data engineer|spark|airflow/i, 'data-engineering'],
  ];
  return [...new Set(
    patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag)
  )];
}

function parsePostedDate(text: string): Date | undefined {
  const now = Date.now();
  const m = text.match(/(\d+)\s*(hour|day|week|month)/i);
  if (!m) return undefined;
  const n = parseInt(m[1]!);
  const unit = m[2]!.toLowerCase();
  const ms = unit.startsWith('hour')  ? n * 3_600_000
           : unit.startsWith('day')   ? n * 86_400_000
           : unit.startsWith('week')  ? n * 7 * 86_400_000
           : unit.startsWith('month') ? n * 30 * 86_400_000
           : 0;
  return ms ? new Date(now - ms) : undefined;
}

export const indeedScraper = new IndeedScraper();
