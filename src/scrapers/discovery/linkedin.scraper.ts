import { Page, BrowserContext } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact, RawJob,
} from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { sessionManager } from '../../core/session.manager.js';
import { proxyManager } from '../../core/proxy.manager.js';
import { logger } from '../../utils/logger.js';
import { randomBetween, generateRunId } from '../../utils/random.js';

// ── Selectors (update here if LinkedIn changes their DOM) ─────────────────────
const SEL = {
  companyCard:    '.entity-result__item',
  companyName:    '.entity-result__title-text a',
  companyUrl:     '.entity-result__title-text a',
  employeeName:   '.artdeco-entity-lockup__title span[aria-hidden="true"]',
  employeeTitle:  '.artdeco-entity-lockup__subtitle span[aria-hidden="true"]',
  employeeEduTab: '.org-page-employees__header-spacing-member',
  jobCard:        '.job-card-container',
  jobTitle:       '.job-card-container__link',
  jobPosted:      '.job-card-container__listed-status',
  globalNav:      '.global-nav',
  captchaFlag:    '[class*="captcha"], #challenge-running, .challenge-dialog',
};

export class LinkedInScraper implements Scraper {
  name = 'linkedin' as const;

  async isAvailable(): Promise<boolean> {
    const session = sessionManager.getAvailableSession('linkedin');
    if (!session) {
      logger.warn('[linkedin] No available LinkedIn session');
      return false;
    }
    return true;
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const session = sessionManager.getAvailableSession('linkedin');
    if (!session) {
      logger.error('[linkedin] No sessions available — skipping scrape');
      return [];
    }

    const browserId = `linkedin-${generateRunId()}`;
    let context: BrowserContext | null = null;
    const results: RawResult[] = [];

    logger.info(
      { accountId: session.accountId, keywords: query.keywords, limit: query.limit },
      '[linkedin] Starting scrape'
    );

    try {
      context = await sessionManager.createSessionContext(session.accountId, browserId);
      const page = await browserManager.newPage(context);

      // ── Step 1: Company search ──────────────────────────────────────────────
      const companies = await this.searchCompanies(page, query);
      logger.info({ found: companies.length }, '[linkedin] Companies found in search');

      // ── Step 2: Visit each company page ────────────────────────────────────
      const limit = query.limit ?? 10;
      for (const company of companies.slice(0, limit)) {
        try {
          const result = await this.scrapeCompanyPage(page, company, session.accountId);
          if (result) {
            results.push(result);
            await sessionManager.recordProfileView(session.accountId);
          }
          await browserManager.humanDelay(
            parseInt(process.env['SCRAPE_DELAY_MIN_MS'] ?? '2000'),
            parseInt(process.env['SCRAPE_DELAY_MAX_MS'] ?? '8000')
          );
        } catch (err) {
          logger.error({ err, company: company.name }, '[linkedin] Failed to scrape company page — skipping');
        }
      }

      // Save updated session cookies
      await sessionManager.saveSession(session.accountId, context);
      logger.info({ companies: results.length }, '[linkedin] Scrape complete');

    } catch (err) {
      logger.error({ err }, '[linkedin] Fatal scrape error');
      if (context) {
        const captcha = await this.checkCaptchaOnContext(context);
        if (captcha) await sessionManager.markBlocked(session.accountId);
      }
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    return results;
  }

  // ── Company Search ──────────────────────────────────────────────────────────

  private async searchCompanies(
    page: Page,
    query: ScrapeQuery
  ): Promise<Array<{ name: string; linkedinUrl: string; slug: string }>> {
    const encoded = encodeURIComponent(query.keywords);
    const url = `https://www.linkedin.com/search/results/companies/?keywords=${encoded}&origin=FACETED_SEARCH`;

    logger.debug({ url }, '[linkedin] Navigating to company search');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 4000);

    // Detect CAPTCHA early
    const hasCaptcha = await browserManager.detectCaptcha(page);
    if (hasCaptcha) {
      logger.warn('[linkedin] CAPTCHA detected on search page');
      return [];
    }

    // Scroll to load more results
    await browserManager.humanScroll(page, 4);

    const cards = await page.$$(SEL.companyCard);
    logger.debug({ count: cards.length }, '[linkedin] Company cards found');

    const companies: Array<{ name: string; linkedinUrl: string; slug: string }> = [];

    for (const card of cards) {
      try {
        const anchor = await card.$(SEL.companyName);
        if (!anchor) continue;

        const name = (await anchor.textContent())?.trim() ?? '';
        const href = (await anchor.getAttribute('href')) ?? '';
        const linkedinUrl = href.split('?')[0] ?? href;
        const slug = linkedinUrl.replace(/.*\/company\//, '').replace(/\/$/, '');

        if (name && linkedinUrl) companies.push({ name, linkedinUrl, slug });
      } catch (err) {
        logger.debug({ err }, '[linkedin] Failed to extract company card');
      }
    }

    return companies;
  }

  // ── Company Page ────────────────────────────────────────────────────────────

  private async scrapeCompanyPage(
    page: Page,
    company: { name: string; linkedinUrl: string; slug: string },
    accountId: string
  ): Promise<RawResult | null> {
    logger.info({ company: company.name, slug: company.slug }, '[linkedin] Scraping company page');

    await page.goto(company.linkedinUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(1500, 3500);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn({ company: company.name }, '[linkedin] CAPTCHA on company page');
      return null;
    }

    // ── Basic company info ──────────────────────────────────────────────────
    const rawCompany: Partial<RawCompany> = {
      name: company.name,
      linkedinUrl: company.linkedinUrl,
      linkedinSlug: company.slug,
    };

    // Website
    const websiteEl = await page.$('[data-field="company_website"] a');
    if (websiteEl) rawCompany.websiteUrl = await websiteEl.getAttribute('href') ?? undefined;

    // HQ location
    const locationEl = await page.$('[data-field="company_hq"] span');
    if (locationEl) {
      const loc = (await locationEl.textContent())?.trim() ?? '';
      const parts = loc.split(',').map(p => p.trim());
      rawCompany.hqCity    = parts[0];
      rawCompany.hqState   = parts[1];
      rawCompany.hqCountry = parts[2] ?? 'US';
    }

    // Employee count range
    const empEl = await page.$('[data-field="company_staff_count_range"] span');
    if (empEl) {
      const empText = (await empEl.textContent())?.trim() ?? '';
      const match = empText.match(/(\d+[\d,]*)/);
      if (match) rawCompany.employeeCount = parseInt(match[1]!.replace(/,/g, ''), 10);
      rawCompany.employeeCountRange = empText;
    }

    // ── People tab — collect employee names + education ─────────────────────
    const employees = await this.scrapeEmployees(page, company.slug);
    logger.info({ company: company.name, employees: employees.length }, '[linkedin] Employees scraped');

    // ── Jobs tab — collect open roles ───────────────────────────────────────
    const jobs = await this.scrapeJobs(page, company.slug);
    logger.info({ company: company.name, jobs: jobs.length }, '[linkedin] Jobs scraped');
    rawCompany.domain = rawCompany.websiteUrl
      ? extractDomain(rawCompany.websiteUrl)
      : `${company.slug}.com`; // fallback — enriched later by Clearbit

    // ── HR contacts search ──────────────────────────────────────────────────
    const hrContacts = await this.searchHRContacts(page, company.name, company.slug);

    return {
      source: 'linkedin',
      company: rawCompany,
      contacts: [
        ...employees.map(e => ({ ...e, companyDomain: rawCompany.domain ?? '' })),
        ...hrContacts,
      ],
      jobs: jobs.map(j => ({ ...j, companyDomain: rawCompany.domain ?? '' })),
      scrapedAt: new Date(),
    };
  }

  // ── Employees (People tab) ──────────────────────────────────────────────────

  private async scrapeEmployees(
    page: Page,
    slug: string
  ): Promise<Partial<RawContact>[]> {
    const url = `https://www.linkedin.com/company/${slug}/people/`;
    logger.debug({ url }, '[linkedin:employees] Navigating to people tab');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await browserManager.humanDelay(1500, 3000);
      await browserManager.humanScroll(page, 6);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn({ slug }, '[linkedin:employees] CAPTCHA on people tab');
        return [];
      }

      const cards = await page.$$(SEL.employeeName);
      const titles = await page.$$(SEL.employeeTitle);
      const employees: Partial<RawContact>[] = [];

      for (let i = 0; i < cards.length; i++) {
        const fullName = (await cards[i]?.textContent())?.trim();
        const title    = (await titles[i]?.textContent())?.trim() ?? '';
        if (!fullName) continue;

        const parts = fullName.split(' ');
        const isDeveloper = /engineer|developer|dev|swe|software|backend|frontend|fullstack|coder|programmer|architect/i
          .test(title);

        employees.push({
          fullName,
          firstName: parts[0],
          lastName:  parts[parts.length - 1],
          role:      isDeveloper ? 'Unknown' : 'Unknown',
          // education + location scraped from profile — async per-profile would hit rate limits
          // We use bulk name list for originRatio estimation in dev-origin.analyzer
        });
      }

      logger.debug({ count: employees.length, slug }, '[linkedin:employees] Extracted employee records');
      return employees;
    } catch (err) {
      logger.error({ err, slug }, '[linkedin:employees] Failed to scrape people tab');
      return [];
    }
  }

  // ── Jobs tab ────────────────────────────────────────────────────────────────

  private async scrapeJobs(
    page: Page,
    slug: string
  ): Promise<Partial<RawJob>[]> {
    const url = `https://www.linkedin.com/company/${slug}/jobs/`;
    logger.debug({ url }, '[linkedin:jobs] Navigating to jobs tab');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await browserManager.humanDelay(1000, 2500);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn({ slug }, '[linkedin:jobs] CAPTCHA on jobs tab');
        return [];
      }

      await browserManager.humanScroll(page, 3);
      const cards = await page.$$(SEL.jobCard);
      const jobs: Partial<RawJob>[] = [];

      for (const card of cards) {
        try {
          const titleEl   = await card.$(SEL.jobTitle);
          const postedEl  = await card.$(SEL.jobPosted);
          const linkEl    = await card.$('a');

          const title      = (await titleEl?.textContent())?.trim();
          const postedText = (await postedEl?.textContent())?.trim() ?? '';
          const sourceUrl  = (await linkEl?.getAttribute('href')) ?? undefined;
          if (!title) continue;

          const postedAt = parsePostedDate(postedText);
          const techTags = extractTechTags(title);

          jobs.push({ title, techTags, sourceUrl, postedAt });
        } catch (err) {
          logger.debug({ err }, '[linkedin:jobs] Failed to parse job card');
        }
      }

      logger.debug({ count: jobs.length, slug }, '[linkedin:jobs] Jobs extracted');
      return jobs;
    } catch (err) {
      logger.error({ err, slug }, '[linkedin:jobs] Failed to scrape jobs tab');
      return [];
    }
  }

  // ── HR / Recruiter Search ───────────────────────────────────────────────────

  private async searchHRContacts(
    page: Page,
    companyName: string,
    slug: string
  ): Promise<Partial<RawContact>[]> {
    const query = `HR Recruiter "${companyName}"`;
    const encoded = encodeURIComponent(query);
    const url = `https://www.linkedin.com/search/results/people/?keywords=${encoded}&origin=FACETED_SEARCH`;

    logger.debug({ url, companyName }, '[linkedin:hr] Searching HR contacts');

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      await browserManager.humanDelay(1500, 3000);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn({ companyName }, '[linkedin:hr] CAPTCHA on HR search');
        return [];
      }

      await browserManager.humanScroll(page, 3);
      const cards = await page.$$('.entity-result__item');
      const contacts: Partial<RawContact>[] = [];

      for (const card of cards.slice(0, 5)) { // max 5 HR contacts per company
        const nameEl  = await card.$('.entity-result__title-text a span[aria-hidden="true"]');
        const titleEl = await card.$('.entity-result__primary-subtitle');
        const linkEl  = await card.$('.entity-result__title-text a');

        const fullName   = (await nameEl?.textContent())?.trim();
        const title      = (await titleEl?.textContent())?.trim() ?? '';
        const linkedinUrl = (await linkEl?.getAttribute('href'))?.split('?')[0];

        if (!fullName) continue;
        const isHR = /hr|human resource|recruiter|talent|people ops|head of people/i.test(title);
        if (!isHR) continue;

        const parts = fullName.split(' ');
        contacts.push({
          fullName,
          firstName: parts[0],
          lastName:  parts[parts.length - 1],
          role:      'HR',
          linkedinUrl,
          companyDomain: `${slug}.com`, // enriched later
        });
      }

      logger.info({ count: contacts.length, companyName }, '[linkedin:hr] HR contacts found');
      return contacts;
    } catch (err) {
      logger.error({ err, companyName }, '[linkedin:hr] Failed to search HR contacts');
      return [];
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async checkCaptchaOnContext(context: BrowserContext): Promise<boolean> {
    const pages = context.pages();
    for (const p of pages) {
      if (await browserManager.detectCaptcha(p)) return true;
    }
    return false;
  }
}

function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
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

function extractTechTags(jobTitle: string): string[] {
  const tagPatterns: [RegExp, string][] = [
    [/node\.?js/i, 'nodejs'],
    [/react/i, 'react'],
    [/next\.?js/i, 'nextjs'],
    [/nest\.?js/i, 'nestjs'],
    [/python/i, 'python'],
    [/typescript/i, 'typescript'],
    [/frontend|front-end|front end/i, 'frontend'],
    [/backend|back-end|back end/i, 'backend'],
    [/fullstack|full.?stack/i, 'fullstack'],
    [/machine learning|ml engineer/i, 'ml'],
    [/ai engineer|generative ai|llm/i, 'generative-ai'],
    [/fastapi|django|flask/i, 'python'],
    [/graphql/i, 'graphql'],
  ];
  return tagPatterns
    .filter(([re]) => re.test(jobTitle))
    .map(([, tag]) => tag);
}

export const linkedInScraper = new LinkedInScraper();
