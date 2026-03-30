import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '../types/index.js';
import { browserManager } from '../core/browser.manager.js';
import { proxyManager } from '../core/proxy.manager.js';
import { logger } from '../utils/logger.js';
import { generateRunId, randomBetween } from '../utils/random.js';

/**
 * Wellfound (formerly AngelList Talent) scraper.
 * COMPLETELY FREE — no API key, no login required for job + company data.
 * Best source for early-stage US startups actively hiring.
 */
export class WellfoundScraper implements Scraper {
  name = 'wellfound' as const;

  async isAvailable(): Promise<boolean> {
    return true; // always available — no auth required
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `wellfound-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords, limit: query.limit }, '[wellfound] Starting scrape');

    try {
      const proxy = proxyManager.getProxy();
      const context = await browserManager.createContext(browserId, { proxy });
      const page = await browserManager.newPage(context);

      const companies = await this.searchJobs(page, query);
      logger.info({ found: companies.length }, '[wellfound] Companies found from job search');

      for (const co of companies.slice(0, query.limit ?? 20)) {
        try {
          const result = await this.scrapeCompanyPage(page, co);
          if (result) results.push(result);
          await browserManager.humanDelay(2000, 5000);
        } catch (err) {
          logger.error({ err, company: co.name }, '[wellfound] Company page failed — skipping');
        }
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[wellfound] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[wellfound] Scrape complete');
    return results;
  }

  // ── Job Search ──────────────────────────────────────────────────────────────

  private async searchJobs(
    page: Page,
    query: ScrapeQuery
  ): Promise<Array<{ name: string; slug: string; wellfoundUrl: string }>> {
    // Wellfound job search — filter by role keywords, US location
    const techParam = (query.techStack ?? []).join(' ').trim() || query.keywords;
    const encoded = encodeURIComponent(techParam);
    const url = `https://wellfound.com/jobs?role=${encoded}&location=United+States`;

    logger.debug({ url }, '[wellfound:search] Navigating to job search');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 4000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[wellfound:search] CAPTCHA detected on search page');
      return [];
    }

    await browserManager.humanScroll(page, 5);

    // Extract company cards from job listing
    const cards = await page.$$('[data-test="StartupResult"], .startup-link, [class*="startupCard"]');
    logger.debug({ cards: cards.length }, '[wellfound:search] Company cards found');

    const companies: Array<{ name: string; slug: string; wellfoundUrl: string }> = [];
    const seen = new Set<string>();

    for (const card of cards) {
      try {
        const anchor = await card.$('a[href*="/company/"]') ?? await card.$('a');
        if (!anchor) continue;
        const href = await anchor.getAttribute('href') ?? '';
        const nameEl = await card.$('h2, h3, [class*="name"], [class*="title"]');
        const name = (await nameEl?.textContent())?.trim() ?? '';
        if (!name || !href.includes('/company/')) continue;

        const slug = href.replace(/.*\/company\//, '').split('/')[0] ?? '';
        if (!slug || seen.has(slug)) continue;
        seen.add(slug);

        companies.push({
          name,
          slug,
          wellfoundUrl: `https://wellfound.com/company/${slug}`,
        });
      } catch (err) {
        logger.debug({ err }, '[wellfound:search] Card parse error');
      }
    }

    return companies;
  }

  // ── Company Page ────────────────────────────────────────────────────────────

  private async scrapeCompanyPage(
    page: Page,
    co: { name: string; slug: string; wellfoundUrl: string }
  ): Promise<RawResult | null> {
    logger.info({ company: co.name, url: co.wellfoundUrl }, '[wellfound:company] Scraping page');

    await page.goto(co.wellfoundUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await browserManager.humanDelay(1500, 3000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn({ company: co.name }, '[wellfound:company] CAPTCHA detected');
      return null;
    }

    await browserManager.humanScroll(page, 3);

    // ── Company info ────────────────────────────────────────────────────────
    const websiteEl  = await page.$('a[data-test="website"], a[href*="http"]:not([href*="wellfound"])');
    const locationEl = await page.$('[data-test="location"], [class*="location"]');
    const empEl      = await page.$('[data-test="employees"], [class*="employee"]');
    const descEl     = await page.$('[data-test="about"], [class*="about"] p, [class*="description"] p');
    const stageEl    = await page.$('[data-test="stage"], [class*="stage"]');

    const websiteUrl  = await websiteEl?.getAttribute('href') ?? undefined;
    const location    = (await locationEl?.textContent())?.trim() ?? '';
    const empText     = (await empEl?.textContent())?.trim() ?? '';
    const description = (await descEl?.textContent())?.trim() ?? undefined;
    const stage       = (await stageEl?.textContent())?.trim() ?? undefined;

    const locParts = location.split(',').map(s => s.trim());
    const domain = websiteUrl
      ? new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./, '')
      : `${co.slug}.com`;

    const rawCompany: Partial<RawCompany> = {
      name:          co.name,
      domain,
      websiteUrl,
      description,
      hqCity:        locParts[0],
      hqState:       locParts[1],
      hqCountry:     'US',
      employeeCount: parseEmployeeText(empText),
      fundingStage:  mapStage(stage),
    };

    // ── Open jobs on the company page ───────────────────────────────────────
    const jobs = await this.scrapeCompanyJobs(page, co.slug, domain);
    logger.info({ company: co.name, domain, jobs: jobs.length }, '[wellfound:company] Page scraped');

    // ── Founders / team (visible without auth) ──────────────────────────────
    const contacts = await this.scrapeFounders(page, domain);

    return {
      source: 'wellfound',
      company: rawCompany,
      contacts,
      jobs,
      scrapedAt: new Date(),
    };
  }

  private async scrapeCompanyJobs(
    page: Page,
    slug: string,
    domain: string
  ): Promise<import('../types/index.js').RawJob[]> {
    const jobCards = await page.$$('[data-test="JobListing"], [class*="job-listing"], [class*="jobCard"]');
    const jobs: import('../types/index.js').RawJob[] = [];

    for (const card of jobCards) {
      const titleEl  = await card.$('h3, h4, [class*="title"], [class*="role"]');
      const title    = (await titleEl?.textContent())?.trim();
      if (!title) continue;

      const tags = extractTechFromTitle(title);
      jobs.push({
        companyDomain: domain,
        title,
        techTags: tags,
        source:   'wellfound',
        sourceUrl: `https://wellfound.com/company/${slug}/jobs`,
        postedAt:  undefined,
      });
    }

    logger.debug({ slug, jobs: jobs.length }, '[wellfound:jobs] Jobs extracted');
    return jobs;
  }

  private async scrapeFounders(
    page: Page,
    domain: string
  ): Promise<Partial<import('../types/index.js').RawContact>[]> {
    const founderCards = await page.$$('[data-test="founder"], [class*="founder"], [class*="team-member"]');
    const contacts: Partial<import('../types/index.js').RawContact>[] = [];

    for (const card of founderCards.slice(0, 5)) {
      const nameEl  = await card.$('h3, h4, [class*="name"]');
      const roleEl  = await card.$('[class*="title"], [class*="role"]');
      const liEl    = await card.$('a[href*="linkedin.com"]');

      const fullName    = (await nameEl?.textContent())?.trim();
      const roleText    = (await roleEl?.textContent())?.trim() ?? '';
      const linkedinUrl = await liEl?.getAttribute('href') ?? undefined;

      if (!fullName) continue;
      const parts = fullName.split(' ');

      contacts.push({
        fullName,
        firstName:    parts[0],
        lastName:     parts[parts.length - 1],
        role:         /ceo|founder|co-founder/i.test(roleText) ? 'Founder' : 'Unknown',
        linkedinUrl,
        companyDomain: domain,
      });
    }

    logger.debug({ domain, contacts: contacts.length }, '[wellfound:founders] Founders extracted');
    return contacts;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEmployeeText(text: string): number | undefined {
  const match = text.match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!match) return undefined;
  if (match[1] && match[2]) return Math.floor((parseInt(match[1]) + parseInt(match[2])) / 2);
  if (match[3]) return parseInt(match[3]);
  return undefined;
}

function mapStage(stage?: string): import('../types/index.js').FundingStage {
  if (!stage) return 'Unknown';
  const s = stage.toLowerCase();
  if (s.includes('series a')) return 'Series A';
  if (s.includes('series b')) return 'Series B';
  if (s.includes('series c')) return 'Series C';
  if (s.includes('seed')) return 'Seed';
  if (s.includes('pre-seed') || s.includes('pre seed')) return 'Pre-seed';
  if (s.includes('bootstrapped') || s.includes('profitable')) return 'Bootstrapped';
  return 'Unknown';
}

function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'], [/react/i, 'react'],
    [/next\.?js/i, 'nextjs'], [/nest\.?js/i, 'nestjs'],
    [/python/i, 'python'], [/typescript/i, 'typescript'],
    [/frontend|front.end/i, 'frontend'], [/backend|back.end/i, 'backend'],
    [/fullstack|full.stack/i, 'fullstack'], [/machine learning|ml/i, 'ml'],
    [/ai engineer|generative/i, 'generative-ai'], [/fastapi|django|flask/i, 'python'],
    [/graphql/i, 'graphql'], [/golang|go\b/i, 'golang'],
  ];
  return patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag);
}

export const wellfoundScraper = new WellfoundScraper();
