import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawJob, ScrapeDiagnosticsSummary,
} from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { proxyManager } from '../../core/proxy.manager.js';
import { logger } from '../../utils/logger.js';
import { generateRunId } from '../../utils/random.js';
import { ScrapeDiagnostics } from '../../utils/scrape-diagnostics.js';

/**
 * Indeed scraper — free job listings.
 * No login required. Great for detecting active hiring per tech stack.
 * Data extracted: job title, company name, location, posting date, tech tags.
 */
export class IndeedScraper implements Scraper {
  name = 'indeed' as const;
  private lastDiagnostics?: ScrapeDiagnosticsSummary;

  async isAvailable(): Promise<boolean> {
    return true; // always available — no auth required
  }

  getLastDiagnostics(): ScrapeDiagnosticsSummary | undefined {
    return this.lastDiagnostics;
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const runId     = generateRunId();
    const browserId = `indeed-${runId}`;
    const results: RawResult[] = [];
    const searchUrl = `https://www.indeed.com/jobs?q=${encodeURIComponent(query.keywords)}&l=United+States&sort=date&radius=0&fromage=14`;
    const diag = new ScrapeDiagnostics('indeed', runId, searchUrl);
    let page: Page | undefined;

    try {
      const proxy = proxyManager.getProxy();
      const contextOpts = proxy ? { proxy } : {};
      const context = await diag.stage('create_context', () => browserManager.createContext(browserId, contextOpts));
      page = await browserManager.newPage(context);

      // Indeed is strongest as a hiring signal; company identity often needs later enrichment.
      const jobGroups = await this.searchJobs(page, query, diag);
      diag.recordItems(jobGroups.size);

      for (const [companyName, jobs] of jobGroups) {
        // Do not invent a domain here; discovery/watchlist handles name-only companies downstream.
        const rawCompany: Partial<RawCompany> = { name: companyName, hqCountry: 'US' };
        results.push({ source: 'indeed', company: rawCompany, jobs, scrapedAt: new Date() });
      }

      const pageText = await page.innerText('body').catch(() => '');
      const captcha  = await browserManager.detectCaptcha(page);
      diag.classify({ captcha, pageText });

      await context.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag.classify({ networkError: /timeout|ENOTFOUND|ECONNREFUSED|net::ERR/i.test(msg) });
      logger.error({ err }, '[indeed] Fatal scrape error');
    } finally {
      this.lastDiagnostics = await diag.finalize(page);
      await browserManager.closeBrowser(browserId);
    }

    return results;
  }

  private async searchJobs(
    page: Page,
    query: ScrapeQuery,
    diag: ScrapeDiagnostics,
  ): Promise<Map<string, RawJob[]>> {
    const q = encodeURIComponent(query.keywords);
    const url = `https://www.indeed.com/jobs?q=${q}&l=United+States&sort=date&radius=0&fromage=14`;

    await diag.stage('navigate', async () => {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await browserManager.humanDelay(2000, 5000);
    });

    if (await browserManager.detectCaptcha(page)) {
      diag.classify({ captcha: true });
      await diag.dump(page, 'captcha_on_search');
      return new Map();
    }

    await diag.stage('scroll', () => browserManager.humanScroll(page, 4));

    // Keep pagination shallow; Indeed gets brittle fast and we care more about freshness than depth.
    const jobGroups = new Map<string, RawJob[]>();
    const limit = query.limit ?? 50;

    for (let p = 0; p < 3; p++) {
      const cards = await page.$$('[class*="job_seen_beacon"], [data-testid="job-title"]');
      logger.debug({ page: p + 1, cards: cards.length }, '[indeed:search] Job cards found');
      if (p === 0 && cards.length === 0) {
        const pageText = await page.innerText('body').catch(() => '');
        diag.classify({ selectorMismatch: !!pageText, pageText });
      }

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
          const jobHref     = await titleEl?.getAttribute('href');
          const companyHref = await companyEl?.getAttribute('href');

          if (!title || !companyName) continue;

          const techTags = extractTechFromTitle(title);
          const postedAt = parsePostedDate(dateText);

          const job: RawJob = {
            // Company domain is intentionally left blank until a later resolver can prove it.
            companyDomain: '',
            title,
            techTags,
            source:    'indeed',
            sourceUrl: absolutizeUrl(jobHref, 'https://www.indeed.com'),
            applyUrl:  absolutizeUrl(companyHref, 'https://www.indeed.com'),
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

function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'], [/react(?!.?native)/i, 'react'],
    [/react native/i, 'react-native'], [/next\.?js/i, 'nextjs'],
    [/nest\.?js/i, 'nestjs'], [/python/i, 'python'],
    [/typescript/i, 'typescript'], [/javascript/i, 'javascript'],
    [/frontend|front.end/i, 'frontend'], [/backend|back.end/i, 'backend'],
    [/fullstack|full.stack/i, 'fullstack'],
    [/machine learning|ml engineer/i, 'ml'],
    [/ai engineer|generative ai|llm/i, 'generative-ai'],
    [/fastapi|django|flask/i, 'python'], [/graphql/i, 'graphql'],
    [/golang|go\b/i, 'golang'], [/java\b/i, 'java'],
    [/ruby|rails/i, 'ruby'], [/rust\b/i, 'rust'],
    [/swift|ios/i, 'ios'], [/android|kotlin/i, 'android'],
    [/devops|sre|platform engineer/i, 'devops'],
    [/data engineer|spark|airflow/i, 'data-engineering'],
    [/cloud|aws|gcp|azure/i, 'cloud'],
    [/mobile/i, 'mobile'],
    // Generic engineering roles — company is hiring engineers regardless of stack
    [/software engineer|software developer|swe\b/i, 'software'],
    [/staff engineer|principal engineer|senior engineer/i, 'software'],
    [/engineering manager|vp of eng|head of eng/i, 'software'],
    [/cto\b/i, 'software'],
  ];
  const tags = [...new Set(
    patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag)
  )];
  // Fall back to a generic engineering tag so clearly-hiring companies are not discarded as "no tech signal".
  return tags.length ? tags : ['software'];
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

function absolutizeUrl(href: string | null | undefined, base: string): string | undefined {
  if (!href) return undefined;
  try {
    return new URL(href, base).toString();
  } catch {
    return undefined;
  }
}
