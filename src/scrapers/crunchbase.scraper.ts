import axios, { AxiosInstance } from 'axios';
import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact, FundingStage,
} from '../types/index.js';
import { browserManager } from '../core/browser.manager.js';
import { proxyManager } from '../core/proxy.manager.js';
import { logger } from '../utils/logger.js';
import { generateRunId } from '../utils/random.js';

const CB_BASE = 'https://api.crunchbase.com/api/v4';

const FUNDING_STAGE_MAP: Record<string, FundingStage> = {
  'seed': 'Seed', 'pre_seed': 'Pre-seed',
  'series_a': 'Series A', 'series_b': 'Series B',
  'series_c': 'Series C', 'series_d': 'Series D+',
  'ipo': 'Public', 'post_ipo': 'Public',
  'acquired': 'Acquired', 'corporate_round': 'Bootstrapped',
};

export class CrunchbaseScraper implements Scraper {
  name = 'crunchbase' as const;
  private apiClient: AxiosInstance;

  constructor() {
    this.apiClient = axios.create({
      baseURL: CB_BASE,
      timeout: 15000,
      params: { user_key: process.env['CRUNCHBASE_API_KEY'] },
    });
  }

  async isAvailable(): Promise<boolean> {
    // Web mode hits crunchbase.com/discover which requires login/CAPTCHA — no results without API key
    return this.hasApiKey;
  }

  private get hasApiKey(): boolean {
    return !!process.env['CRUNCHBASE_API_KEY'];
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    if (this.hasApiKey) {
      logger.info({ keywords: query.keywords }, '[crunchbase] Using API mode');
      return this.scrapeViaApi(query);
    }
    logger.info({ keywords: query.keywords }, '[crunchbase] No API key — using web scraping mode');
    return this.scrapeViaWeb(query);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API MODE
  // ══════════════════════════════════════════════════════════════════════════

  private async scrapeViaApi(query: ScrapeQuery): Promise<RawResult[]> {
    const results: RawResult[] = [];

    try {
      const payload = {
        field_ids: ['identifier', 'short_description', 'num_employees_enum', 'last_funding_type'],
        query: [
          { type: 'predicate', field_id: 'location_identifiers', operator_id: 'includes', values: ['United States'] },
          { type: 'predicate', field_id: 'num_employees_enum', operator_id: 'includes', values: ['c_00011_00050', 'c_00051_00100', 'c_00101_00250', 'c_00251_00500'] },
          { type: 'predicate', field_id: 'facet_ids', operator_id: 'includes', values: ['company'] },
        ],
        limit: query.limit ?? 25,
      };

      const res = await this.apiClient.post<{
        entities: Array<{ identifier: { permalink: string } }>;
      }>('/searches/organizations', payload);

      const permalinks = res.data.entities.map(e => e.identifier.permalink);
      logger.info({ count: permalinks.length }, '[crunchbase:api] Orgs found');

      for (const permalink of permalinks) {
        try {
          const result = await this.getOrganizationViaApi(permalink);
          if (result) results.push(result);
          await new Promise(r => setTimeout(r, 400));
        } catch (err) {
          logger.error({ err, permalink }, '[crunchbase:api] Org fetch failed — skipping');
        }
      }
    } catch (err) {
      logger.error({ err }, '[crunchbase:api] Fatal API error');
    }

    return results;
  }

  private async getOrganizationViaApi(permalink: string): Promise<RawResult | null> {
    const fields = [
      'identifier', 'short_description', 'website_url', 'linkedin', 'num_employees_enum',
      'last_funding_type', 'funding_total', 'founded_on', 'location_identifiers', 'categories',
    ].join(',');

    const res = await this.apiClient.get<{ properties: Record<string, unknown> }>(
      `/entities/organizations/${permalink}`,
      { params: { field_ids: fields } }
    );

    const p = res.data.properties as any;
    const locs = (p.location_identifiers ?? []) as Array<{ location_type: string; value: string }>;
    const country = locs.find(l => l.location_type === 'country')?.value ?? '';
    if (!country.toLowerCase().includes('united states')) return null;

    const domain = p.website_url
      ? new URL(p.website_url).hostname.replace(/^www\./, '')
      : `${permalink}.com`;

    const rawCompany: Partial<RawCompany> = {
      name:            p.identifier?.value,
      domain,
      websiteUrl:      p.website_url,
      linkedinUrl:     p.linkedin?.value,
      description:     p.short_description,
      hqCity:          locs.find(l => l.location_type === 'city')?.value,
      hqState:         locs.find(l => l.location_type === 'region')?.value,
      hqCountry:       'US',
      employeeCount:   parseEmployeeEnum(p.num_employees_enum),
      fundingStage:    FUNDING_STAGE_MAP[p.last_funding_type ?? ''] ?? 'Unknown',
      fundingTotalUsd: (p.funding_total as any)?.value_usd,
      industry:        ((p.categories as any[]) ?? []).map((c: any) => c.value),
    };

    logger.debug({ domain, stage: rawCompany.fundingStage }, '[crunchbase:api] Org fetched');
    return { source: 'crunchbase', company: rawCompany, contacts: [], scrapedAt: new Date() };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB SCRAPING MODE (no API key needed)
  // ══════════════════════════════════════════════════════════════════════════

  private async scrapeViaWeb(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `crunchbase-${generateRunId()}`;
    const results: RawResult[] = [];

    try {
      const proxy = proxyManager.getProxy();
      const contextOptions = proxy ? { proxy } : {};
      const context = await browserManager.createContext(browserId, contextOptions);
      const page = await browserManager.newPage(context);

      const companies = await this.webSearchCompanies(page, query);
      logger.info({ found: companies.length }, '[crunchbase:web] Companies found');

      for (const co of companies.slice(0, query.limit ?? 20)) {
        try {
          const result = await this.webScrapeCompany(page, co);
          if (result) results.push(result);
          await browserManager.humanDelay(2500, 6000);
        } catch (err) {
          logger.error({ err, slug: co.slug }, '[crunchbase:web] Company scrape failed — skipping');
        }
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[crunchbase:web] Fatal error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[crunchbase:web] Scrape complete');
    return results;
  }

  private async webSearchCompanies(
    page: Page,
    query: ScrapeQuery
  ): Promise<Array<{ name: string; slug: string }>> {
    const encoded = encodeURIComponent(query.keywords);
    const url = `https://www.crunchbase.com/discover/organization.companies?field_ids=identifier,short_description,location_identifiers,num_employees_enum,last_funding_type&predefined_filter=company&query=${encoded}`;

    logger.debug({ url }, '[crunchbase:web] Navigating to discover page');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(3000, 6000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[crunchbase:web] CAPTCHA on discover page');
      return [];
    }

    await browserManager.humanScroll(page, 4);

    // Try grid/list results
    const cards = await page.$$('[class*="component--card"], [data-testid="organization-result"]');
    logger.debug({ count: cards.length }, '[crunchbase:web] Result cards found');

    const companies: Array<{ name: string; slug: string }> = [];
    for (const card of cards) {
      const anchor = await card.$('a[href*="/organization/"]');
      if (!anchor) continue;
      const href = await anchor.getAttribute('href') ?? '';
      const slug = href.replace(/.*\/organization\//, '').split('/')[0] ?? '';
      const nameEl = await card.$('[class*="identifier"], h3, h4');
      const name   = (await nameEl?.textContent())?.trim() ?? slug;
      if (slug && name) companies.push({ name, slug });
    }

    return companies;
  }

  private async webScrapeCompany(
    page: Page,
    co: { name: string; slug: string }
  ): Promise<RawResult | null> {
    const url = `https://www.crunchbase.com/organization/${co.slug}`;
    logger.info({ company: co.name, url }, '[crunchbase:web] Scraping company page');

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 4000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn({ slug: co.slug }, '[crunchbase:web] CAPTCHA on company page');
      return null;
    }

    await browserManager.humanScroll(page, 3);

    // Safe text extractor
    const getText = async (sel: string): Promise<string | undefined> => {
      try {
        const el = await page.$(sel);
        return (await el?.textContent())?.trim() ?? undefined;
      } catch { return undefined; }
    };

    const getAttr = async (sel: string, attr: string): Promise<string | undefined> => {
      try {
        const el = await page.$(sel);
        return (await el?.getAttribute(attr)) ?? undefined;
      } catch { return undefined; }
    };

    const websiteUrl   = await getAttr('a[aria-label="Website"]', 'href');
    const linkedinUrl  = await getAttr('a[aria-label="LinkedIn"]', 'href');
    const description  = await getText('[class*="description"] span, [data-testid="description"]');
    const employeeText = await getText('[data-testid="num-employees"], [class*="employee"]');
    const stageText    = await getText('[data-testid="funding-type"], [class*="last-funding"]');
    const locationText = await getText('[data-testid="headquarters"], [class*="location"]');

    const locParts = (locationText ?? '').split(',').map(s => s.trim());
    const domain = websiteUrl
      ? new URL(websiteUrl.startsWith('http') ? websiteUrl : `https://${websiteUrl}`).hostname.replace(/^www\./, '')
      : `${co.slug}.com`;

    const rawCompany: Partial<RawCompany> = {
      name:          co.name,
      domain,
      websiteUrl:    websiteUrl ?? undefined,
      linkedinUrl:   linkedinUrl ?? undefined,
      description:   description?.trim(),
      hqCity:        locParts[0],
      hqState:       locParts[1],
      hqCountry:     'US',
      employeeCount: parseEmployeeText(employeeText ?? ''),
      fundingStage:  mapStageText(stageText ?? ''),
    };

    // Founders section (visible without auth)
    const founderEls = await page.$$('[data-testid="founders-section"] [class*="person"]');
    const contacts: Partial<RawContact>[] = [];
    for (const el of founderEls.slice(0, 3)) {
      const nameEl = await el.$('[class*="name"]');
      const liEl   = await el.$('a[href*="linkedin"]');
      const fullName = (await nameEl?.textContent())?.trim();
      if (!fullName) continue;
      const parts = fullName.split(' ');
      contacts.push({
        fullName,
        firstName:    parts[0],
        lastName:     parts[parts.length - 1],
        role:         'Founder',
        linkedinUrl:  (await liEl?.getAttribute('href')) ?? undefined,
        companyDomain: domain,
      });
    }

    logger.info({ domain, stage: rawCompany.fundingStage, employees: rawCompany.employeeCount }, '[crunchbase:web] Company scraped');
    return { source: 'crunchbase', company: rawCompany, contacts, scrapedAt: new Date() };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseEmployeeEnum(val: string): number | undefined {
  const map: Record<string, number> = {
    'c_00001_00010': 5, 'c_00011_00050': 30, 'c_00051_00100': 75,
    'c_00101_00250': 175, 'c_00251_00500': 375,
  };
  return map[val];
}

function parseEmployeeText(text: string): number | undefined {
  const m = text.match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!m) return undefined;
  if (m[1] && m[2]) return Math.floor((parseInt(m[1]) + parseInt(m[2])) / 2);
  if (m[3]) return parseInt(m[3]);
  return undefined;
}

function mapStageText(text: string): FundingStage {
  const t = text.toLowerCase();
  if (t.includes('series a')) return 'Series A';
  if (t.includes('series b')) return 'Series B';
  if (t.includes('series c')) return 'Series C';
  if (t.includes('seed')) return 'Seed';
  if (t.includes('pre-seed') || t.includes('pre seed')) return 'Pre-seed';
  return 'Unknown';
}

export const crunchbaseScraper = new CrunchbaseScraper();
