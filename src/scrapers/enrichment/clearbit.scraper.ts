import axios, { AxiosInstance } from 'axios';
import { Page } from 'playwright';
import { Scraper, ScrapeQuery, RawResult, RawCompany } from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { logger } from '../../utils/logger.js';
import { generateRunId } from '../../utils/random.js';

/**
 * Clearbit enricher — given a domain, returns company name, description,
 * logo, tech stack, headcount, and funding stage.
 *
 * Dual-mode:
 *   - API mode: uses CLEARBIT_API_KEY (Clearbit Enrichment API)
 *   - Web mode: scrapes clearbit.com/companies/DOMAIN (slower, no key needed)
 */
export class ClearbitScraper implements Scraper {
  name = 'clearbit' as const;
  private apiClient: AxiosInstance;

  constructor() {
    this.apiClient = axios.create({
      baseURL: 'https://company.clearbit.com/v2',
      timeout: 10000,
      auth: { username: process.env['CLEARBIT_API_KEY'] ?? '', password: '' },
    });
  }

  async isAvailable(): Promise<boolean> {
    return true; // always available — web mode when no API key
  }

  private get hasApiKey(): boolean {
    return !!process.env['CLEARBIT_API_KEY'];
  }

  async scrape(_query: ScrapeQuery): Promise<RawResult[]> {
    logger.warn('[clearbit] Use enrichDomain() directly — Clearbit is domain-level enrichment');
    return [];
  }

  /** Main entry: enrich a company by domain */
  async enrichDomain(domain: string): Promise<RawResult | null> {
    if (this.hasApiKey) {
      logger.debug({ domain }, '[clearbit] Using API mode');
      return this.enrichViaApi(domain);
    }
    logger.debug({ domain }, '[clearbit] No API key — using web mode');
    return this.enrichViaWeb(domain);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API MODE
  // ══════════════════════════════════════════════════════════════════════════

  private async enrichViaApi(domain: string): Promise<RawResult | null> {
    try {
      const res = await this.apiClient.get<{
        name: string;
        description: string;
        domain: string;
        logo: string;
        foundedYear: number;
        metrics: { employees: number; estimatedAnnualRevenue: string };
        tech: string[];
        tags: string[];
        category: { industry: string; sector: string };
        location: string;
        geo: { city: string; state: string; country: string };
        crunchbaseFundingLevel: string;
        linkedin: { handle: string };
      }>(`/companies/find?domain=${domain}`);

      const d = res.data;
      const rawCompany: Partial<RawCompany> = {
        name:          d.name,
        domain,
        description:   d.description,
        employeeCount: d.metrics?.employees,
        foundedYear:   d.foundedYear,
        industry:      [d.category?.industry, d.category?.sector].filter(Boolean) as string[],
        techStack:     d.tech ?? [],
        hqCity:        d.geo?.city,
        hqState:       d.geo?.state,
        hqCountry:     d.geo?.country === 'US' ? 'US' : d.geo?.country,
        linkedinUrl:   d.linkedin?.handle ? `https://linkedin.com/company/${d.linkedin.handle}` : undefined,
      };

      logger.info(
        { domain, employees: rawCompany.employeeCount, tech: rawCompany.techStack?.length },
        '[clearbit:api] Company enriched'
      );

      return { source: 'clearbit', company: rawCompany, scrapedAt: new Date() };
    } catch (err: any) {
      if (err?.response?.status === 404) {
        logger.debug({ domain }, '[clearbit:api] Company not found in Clearbit');
      } else {
        logger.error({ err, domain }, '[clearbit:api] API call failed');
      }
      return null;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB MODE (no API key)
  // Scrapes app.clearbit.com/companies/DOMAIN — public company profile page
  // ══════════════════════════════════════════════════════════════════════════

  private async enrichViaWeb(domain: string): Promise<RawResult | null> {
    const browserId = `clearbit-${generateRunId()}`;
    try {
      const context = await browserManager.createContext(browserId, {});
      const page = await browserManager.newPage(context);

      const url = `https://clearbit.com/companies/${domain}`;
      logger.debug({ url }, '[clearbit:web] Navigating');

      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await browserManager.humanDelay(2000, 4000);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn({ domain }, '[clearbit:web] CAPTCHA detected');
        await context.close();
        return null;
      }

      const getText = async (sel: string): Promise<string | undefined> => {
        try {
          const el = await page.$(sel);
          return (await el?.textContent())?.trim() ?? undefined;
        } catch { return undefined; }
      };

      const name        = await getText('h1, [class*="company-name"]');
      const description = await getText('[class*="description"], [class*="about"]');
      const employees   = await getText('[class*="employees"], [class*="headcount"]');
      const location    = await getText('[class*="location"], [class*="hq"]');
      const industry    = await getText('[class*="industry"], [class*="category"]');

      const locParts = (location ?? '').split(',').map(s => s.trim());

      const rawCompany: Partial<RawCompany> = {
        name:         name ?? domain,
        domain,
        description,
        employeeCount: parseEmpText(employees ?? ''),
        industry:     industry ? [industry] : [],
        hqCity:       locParts[0],
        hqState:      locParts[1],
        hqCountry:    'US',
      };

      await context.close();
      logger.info({ domain, employees: rawCompany.employeeCount }, '[clearbit:web] Company enriched');

      return { source: 'clearbit', company: rawCompany, scrapedAt: new Date() };
    } catch (err) {
      logger.error({ err, domain }, '[clearbit:web] Failed');
      return null;
    } finally {
      await browserManager.closeBrowser(browserId);
    }
  }
}

function parseEmpText(text: string): number | undefined {
  const m = text.replace(/,/g, '').match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!m) return undefined;
  if (m[1] && m[2]) return Math.floor((parseInt(m[1]) + parseInt(m[2])) / 2);
  if (m[3]) return parseInt(m[3]);
  return undefined;
}

export const clearbitScraper = new ClearbitScraper();
