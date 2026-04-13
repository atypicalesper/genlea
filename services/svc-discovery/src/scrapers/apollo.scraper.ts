import axios, { AxiosInstance } from 'axios';
import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '@genlea/shared';
import { browserManager } from '@genlea/shared';
import { proxyManager } from '@genlea/shared';
import { logger } from '@genlea/shared';
import { generateRunId } from '@genlea/shared';

export class ApolloScraper implements Scraper {
  name = 'apollo' as const;
  private apiClient: AxiosInstance;

  constructor() {
    this.apiClient = axios.create({
      baseURL: 'https://api.apollo.io/v1',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'X-Api-Key': process.env['APOLLO_API_KEY'] ?? '',
      },
      timeout: 15000,
    });
  }

  async isAvailable(): Promise<boolean> {
    // Web mode hits app.apollo.io which requires login — no results without API key
    return this.hasApiKey;
  }

  private get hasApiKey(): boolean {
    return !!process.env['APOLLO_API_KEY'];
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    if (this.hasApiKey) {
      logger.info({ keywords: query.keywords }, '[apollo] Using API mode');
      return this.scrapeViaApi(query);
    }
    logger.info({ keywords: query.keywords }, '[apollo] No API key — using web scraping mode');
    return this.scrapeViaWeb(query);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // API MODE
  // ══════════════════════════════════════════════════════════════════════════

  private async scrapeViaApi(query: ScrapeQuery): Promise<RawResult[]> {
    const results: RawResult[] = [];

    try {
      const payload = {
        q_organization_keyword_tags: query.techStack ?? query.keywords.split(' '),
        organization_locations: ['United States'],
        organization_num_employees_ranges: ['11,500'],
        page: 1,
        per_page: query.limit ?? 25,
      };

      const res = await this.apiClient.post<{
        organizations: Array<{
          name: string; website_url: string; linkedin_url: string;
          primary_domain: string; short_description: string;
          estimated_num_employees: number; industry: string;
          city: string; state: string; country: string;
        }>;
      }>('/mixed_companies/search', payload);

      const orgs = res.data.organizations ?? [];
      logger.info({ found: orgs.length }, '[apollo:api] Companies found');

      for (const org of orgs) {
        try {
          const contacts = await this.findContactsViaApi(org.name, org.primary_domain);
          results.push({
            source: 'apollo',
            company: {
              name: org.name, domain: org.primary_domain,
              websiteUrl: org.website_url, linkedinUrl: org.linkedin_url,
              description: org.short_description,
              employeeCount: org.estimated_num_employees,
              industry: org.industry ? [org.industry] : [],
              hqCity: org.city, hqState: org.state, hqCountry: 'US',
            },
            contacts,
            scrapedAt: new Date(),
          });
          logger.debug({ domain: org.primary_domain }, '[apollo:api] Company enriched');
        } catch (err) {
          logger.error({ err, domain: org.primary_domain }, '[apollo:api] Contact fetch failed — skipping');
        }
      }
    } catch (err) {
      logger.error({ err }, '[apollo:api] Fatal API error');
    }

    return results;
  }

  private async findContactsViaApi(companyName: string, domain: string): Promise<Partial<RawContact>[]> {
    const res = await this.apiClient.post<{
      people: Array<{
        first_name: string; last_name: string; name: string;
        title: string; email: string; email_status: string;
        linkedin_url: string; phone_numbers: Array<{ sanitized_number: string }>;
      }>;
    }>('/mixed_people/search', {
      q_organization_name: companyName,
      person_titles: ['CEO', 'Chief Executive Officer', 'Founder', 'Co-Founder',
                      'HR', 'Head of Talent', 'Recruiter', 'People Operations'],
      person_locations: ['United States'],
      page: 1, per_page: 10,
    });

    const people = res.data.people ?? [];
    logger.debug({ count: people.length, companyName }, '[apollo:api] Contacts found');

    return people.map(p => ({
      fullName: p.name, firstName: p.first_name, lastName: p.last_name,
      role: resolveRole(p.title), companyDomain: domain,
      email: p.email, emailConfidence: p.email_status === 'verified' ? 0.95 : 0.70,
      phone: p.phone_numbers?.[0]?.sanitized_number,
      linkedinUrl: p.linkedin_url,
    }));
  }

  // ══════════════════════════════════════════════════════════════════════════
  // WEB SCRAPING MODE (no API key needed)
  // Scrapes apollo.io's public search — limited but free
  // ══════════════════════════════════════════════════════════════════════════

  private async scrapeViaWeb(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `apollo-${generateRunId()}`;
    const results: RawResult[] = [];

    try {
      const proxy = proxyManager.getProxy();
      const contextOptions = proxy ? { proxy } : {};
      const context = await browserManager.createContext(browserId, contextOptions);
      const page = await browserManager.newPage(context);

      // Apollo people search is the most publicly visible (no auth for first page)
      const contacts = await this.webSearchPeople(page, query);
      logger.info({ found: contacts.length }, '[apollo:web] Contacts found via web');

      // Group contacts by company domain
      const byDomain = new Map<string, Partial<RawContact>[]>();
      for (const c of contacts) {
        const d = c.companyDomain ?? 'unknown';
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d)!.push(c);
      }

      for (const [domain, domainContacts] of byDomain) {
        if (domain === 'unknown') continue;
        results.push({
          source: 'apollo',
          company: { domain, hqCountry: 'US' } as Partial<RawCompany>,
          contacts: domainContacts,
          scrapedAt: new Date(),
        });
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[apollo:web] Fatal error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[apollo:web] Scrape complete');
    return results;
  }

  private async webSearchPeople(page: Page, query: ScrapeQuery): Promise<Partial<RawContact>[]> {
    // Apollo's public people search (limited to first page without auth)
    const titles = ['HR', 'Recruiter', 'Talent', 'CEO', 'Founder'].join(' OR ');
    const encoded = encodeURIComponent(
      `${query.keywords} (${titles}) United States`
    );
    const url = `https://app.apollo.io/#/people?q=${encoded}&personTitles[]=CEO&personTitles[]=Recruiter&personLocations[]=United+States`;

    logger.debug({ url }, '[apollo:web] Navigating to people search');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(3000, 6000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[apollo:web] CAPTCHA on people search — falling back to empty');
      return [];
    }

    // Apollo is an SPA — wait for content to load
    await page.waitForSelector('[class*="zp_person"], [data-testid="person-row"]', {
      timeout: 15000,
    }).catch(() => {
      logger.debug('[apollo:web] Person rows not found — page may require login');
    });

    await browserManager.humanScroll(page, 3);

    const rows = await page.$$('[class*="zp_person"], [data-testid="person-row"], .person-row');
    logger.debug({ rows: rows.length }, '[apollo:web] Person rows found');

    const contacts: Partial<RawContact>[] = [];

    for (const row of rows) {
      try {
        const nameEl    = await row.$('[class*="name"], .person-name');
        const titleEl   = await row.$('[class*="title"], .person-title');
        const companyEl = await row.$('[class*="company"], .person-company');
        const liEl      = await row.$('a[href*="linkedin.com"]');

        const fullName    = (await nameEl?.textContent())?.trim();
        const title       = (await titleEl?.textContent())?.trim() ?? '';
        const companyName = (await companyEl?.textContent())?.trim() ?? '';
        const linkedinUrl = await liEl?.getAttribute('href') ?? undefined;

        if (!fullName) continue;
        const parts = fullName.split(' ');

        contacts.push({
          fullName,
          firstName:    parts[0],
          lastName:     parts[parts.length - 1],
          role:         resolveRole(title),
          companyDomain: slugifyName(companyName),
          linkedinUrl,
        });
      } catch (err) {
        logger.debug({ err }, '[apollo:web] Row parse error');
      }
    }

    return contacts;
  }
}

function resolveRole(title: string): import('@genlea/shared').ContactRole {
  const t = (title ?? '').toLowerCase();
  if (/ceo|chief executive|founder|co-founder/.test(t)) return 'CEO';
  if (/cto|chief tech|vp eng/.test(t)) return 'CTO';
  if (/hr|human resource|recruiter|talent|people ops/.test(t)) return 'HR';
  return 'Unknown';
}

function slugifyName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 30) + '.com';
}

export const apolloScraper = new ApolloScraper();
