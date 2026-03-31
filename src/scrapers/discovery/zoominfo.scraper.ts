import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { sessionManager } from '../../core/session.manager.js';
import { logger } from '../../utils/logger.js';
import { generateRunId } from '../../utils/random.js';

/**
 * ZoomInfo scraper — Playwright stealth login + company/contact scraping.
 * Requires a ZoomInfo account (ZOOMINFO_USERNAME + ZOOMINFO_PASSWORD).
 *
 * Data available on ZoomInfo:
 * - Direct-dial phone numbers (highest quality source)
 * - Work emails with high confidence
 * - CEO + HR contacts
 * - Company funding, headcount, tech stack via "TechStack" tab
 */
export class ZoomInfoScraper implements Scraper {
  name = 'zoominfo' as const;

  async isAvailable(): Promise<boolean> {
    if (!process.env['ZOOMINFO_USERNAME'] || !process.env['ZOOMINFO_PASSWORD']) {
      logger.warn('[zoominfo] ZOOMINFO_USERNAME or ZOOMINFO_PASSWORD not set');
      return false;
    }
    return true;
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    if (!(await this.isAvailable())) return [];

    const browserId = `zoominfo-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords }, '[zoominfo] Starting scrape');

    try {
      const context = await browserManager.createContext(browserId, {});
      const page = await browserManager.newPage(context);

      // ── Step 1: Login ────────────────────────────────────────────────────
      const loggedIn = await this.login(page);
      if (!loggedIn) {
        logger.error('[zoominfo] Login failed — aborting scrape');
        await context.close();
        return [];
      }

      // ── Step 2: Company search ────────────────────────────────────────────
      const companies = await this.searchCompanies(page, query);
      logger.info({ found: companies.length }, '[zoominfo] Companies found');

      // ── Step 3: Scrape each company ───────────────────────────────────────
      for (const co of companies.slice(0, query.limit ?? 15)) {
        try {
          const result = await this.scrapeCompanyProfile(page, co);
          if (result) {
            results.push(result);
            logger.debug({ company: co.name }, '[zoominfo] Company scraped');
          }
          await browserManager.humanDelay(3000, 7000);
        } catch (err) {
          logger.error({ err, company: co.name }, '[zoominfo] Company scrape failed — skipping');
        }
      }

      await browserManager.saveCookies(context, `sessions/zoominfo/session.json`);
      await context.close();

    } catch (err) {
      logger.error({ err }, '[zoominfo] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[zoominfo] Scrape complete');
    return results;
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    logger.info('[zoominfo:login] Attempting login');

    try {
      await page.goto('https://app.zoominfo.com/#!/login', {
        waitUntil: 'networkidle', timeout: 30000,
      });
      await browserManager.humanDelay(1500, 3000);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn('[zoominfo:login] CAPTCHA on login page');
        return false;
      }

      // Fill credentials
      const emailInput = await page.$('input[type="email"], input[name="username"], input[placeholder*="email" i]');
      if (!emailInput) {
        logger.error('[zoominfo:login] Email input not found');
        return false;
      }
      await emailInput.click();
      await emailInput.type(process.env['ZOOMINFO_USERNAME']!, { delay: 80 });
      await browserManager.humanDelay(500, 1000);

      // Click next / continue
      const nextBtn = await page.$('button[type="submit"], button:has-text("Continue"), button:has-text("Next")');
      if (nextBtn) {
        await nextBtn.click();
        await browserManager.humanDelay(1500, 3000);
      }

      const passInput = await page.$('input[type="password"]');
      if (!passInput) {
        logger.error('[zoominfo:login] Password input not found');
        return false;
      }
      await passInput.click();
      await passInput.type(process.env['ZOOMINFO_PASSWORD']!, { delay: 90 });
      await browserManager.humanDelay(500, 1000);

      const loginBtn = await page.$('button[type="submit"], button:has-text("Login"), button:has-text("Sign In")');
      if (loginBtn) await loginBtn.click();

      // Wait for dashboard
      await page.waitForNavigation({ waitUntil: 'networkidle', timeout: 20000 }).catch(() => {});
      await browserManager.humanDelay(2000, 4000);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn('[zoominfo:login] CAPTCHA after login');
        return false;
      }

      // Check if we're logged in
      const url = page.url();
      const loggedIn = !url.includes('login') && !url.includes('signin');
      logger.info({ url, loggedIn }, '[zoominfo:login] Login status');
      return loggedIn;

    } catch (err) {
      logger.error({ err }, '[zoominfo:login] Login error');
      return false;
    }
  }

  // ── Company Search ────────────────────────────────────────────────────────

  private async searchCompanies(
    page: Page,
    query: ScrapeQuery
  ): Promise<Array<{ name: string; zoomUrl: string }>> {
    const encoded = encodeURIComponent(query.keywords);
    const url = `https://app.zoominfo.com/#!/search/company?companyKeyword=${encoded}&employeeSizeRange=11-500&country=United+States`;

    logger.debug({ url }, '[zoominfo:search] Navigating to company search');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await browserManager.humanDelay(3000, 6000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[zoominfo:search] CAPTCHA on search page');
      return [];
    }

    await browserManager.humanScroll(page, 4);

    const cards = await page.$$('[class*="company-card"], [class*="search-result"], .company-row');
    logger.debug({ count: cards.length }, '[zoominfo:search] Company cards found');

    const companies: Array<{ name: string; zoomUrl: string }> = [];
    for (const card of cards) {
      const anchor = await card.$('a[href*="/company"]');
      const nameEl = await card.$('h3, h4, [class*="company-name"]');
      const name   = (await nameEl?.textContent())?.trim() ?? '';
      const href   = await anchor?.getAttribute('href') ?? '';
      if (name && href) {
        companies.push({
          name,
          zoomUrl: href.startsWith('http') ? href : `https://app.zoominfo.com${href}`,
        });
      }
    }

    return companies;
  }

  // ── Company Profile ───────────────────────────────────────────────────────

  private async scrapeCompanyProfile(
    page: Page,
    co: { name: string; zoomUrl: string }
  ): Promise<RawResult | null> {
    logger.info({ company: co.name }, '[zoominfo:profile] Scraping company');

    await page.goto(co.zoomUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await browserManager.humanDelay(2000, 4000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn({ company: co.name }, '[zoominfo:profile] CAPTCHA on company page');
      return null;
    }

    await browserManager.humanScroll(page, 3);

    const getText = async (sel: string) => {
      try {
        const el = await page.$(sel);
        return (await el?.textContent())?.trim() ?? undefined;
      } catch { return undefined; }
    };

    const websiteUrl   = await getText('[class*="website"] a');
    const employeeText = await getText('[class*="employees"], [class*="headcount"]');
    const stageText    = await getText('[class*="funding"], [class*="revenue"]');
    const locationText = await getText('[class*="location"], [class*="headquarters"]');

    const locParts = (locationText ?? '').split(',').map(s => s.trim());
    const domain = websiteUrl
      ? new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./, '')
      : co.name.toLowerCase().replace(/\s+/g, '') + '.com';

    const rawCompany: Partial<RawCompany> = {
      name:  co.name,
      domain,
      websiteUrl,
      hqCity:  locParts[0],
      hqState: locParts[1],
      hqCountry: 'US',
      employeeCount: parseEmpText(employeeText ?? ''),
    };

    // ── Contacts (CEO + HR) ─────────────────────────────────────────────────
    const contacts = await this.scrapeContacts(page, domain);
    logger.info({ company: co.name, contacts: contacts.length }, '[zoominfo:profile] Profile scraped');

    return { source: 'zoominfo', company: rawCompany, contacts, scrapedAt: new Date() };
  }

  private async scrapeContacts(page: Page, domain: string): Promise<Partial<RawContact>[]> {
    const contacts: Partial<RawContact>[] = [];

    // Click on "Contacts" tab
    const tabEl = await page.$('a:has-text("Contacts"), button:has-text("Contacts"), [class*="contacts-tab"]');
    if (tabEl) {
      await tabEl.click();
      await browserManager.humanDelay(2000, 4000);
    }

    const rows = await page.$$('[class*="contact-row"], [class*="person-card"]');
    logger.debug({ count: rows.length }, '[zoominfo:contacts] Contact rows found');

    for (const row of rows.slice(0, 10)) {
      try {
        const nameEl  = await row.$('[class*="name"]');
        const titleEl = await row.$('[class*="title"], [class*="role"]');
        const emailEl = await row.$('[class*="email"]');
        const phoneEl = await row.$('[class*="phone"]');
        const liEl    = await row.$('a[href*="linkedin"]');

        const fullName   = (await nameEl?.textContent())?.trim();
        const titleText  = (await titleEl?.textContent())?.trim() ?? '';
        const email      = (await emailEl?.textContent())?.trim();
        const phone      = (await phoneEl?.textContent())?.trim();
        const linkedinUrl = await liEl?.getAttribute('href') ?? undefined;

        if (!fullName) continue;

        const role = resolveRole(titleText);
        if (!['CEO', 'Founder', 'CTO', 'HR', 'Recruiter', 'Head of Talent'].includes(role)) continue;

        const parts = fullName.split(' ');
        contacts.push({
          fullName,
          firstName: parts[0],
          lastName:  parts[parts.length - 1],
          role,
          email,
          emailConfidence: email ? 0.85 : 0, // ZoomInfo emails are generally high quality
          phone,
          linkedinUrl,
          companyDomain: domain,
        });
      } catch (err) {
        logger.debug({ err }, '[zoominfo:contacts] Row parse error');
      }
    }

    return contacts;
  }
}

function resolveRole(title: string): import('../../types/index.js').ContactRole {
  const t = (title ?? '').toLowerCase();
  if (/ceo|chief executive|founder|co-founder/.test(t)) return 'CEO';
  if (/cto|chief tech/.test(t)) return 'CTO';
  if (/hr|human resource|recruiter|talent|people/.test(t)) return 'HR';
  return 'Unknown';
}

function parseEmpText(text: string): number | undefined {
  const m = text.replace(/,/g, '').match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!m) return undefined;
  if (m[1] && m[2]) return Math.floor((parseInt(m[1]) + parseInt(m[2])) / 2);
  if (m[3]) return parseInt(m[3]);
  return undefined;
}

export const zoomInfoScraper = new ZoomInfoScraper();
