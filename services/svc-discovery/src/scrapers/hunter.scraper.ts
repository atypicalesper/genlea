import axios, { AxiosInstance } from 'axios';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '@genlea/shared';
import { browserManager } from '@genlea/shared';
import { proxyManager } from '@genlea/shared';
import { emailVerifier } from '@genlea/shared';
import { logger } from '@genlea/shared';
import { generateRunId } from '@genlea/shared';

// Common corporate email patterns, tried in order of frequency
const EMAIL_PATTERNS = [
  (f: string, l: string) => `${f}.${l}`,       // john.doe
  (f: string, l: string) => `${f[0]}${l}`,      // jdoe
  (f: string, l: string) => `${f}`,             // john
  (f: string, l: string) => `${f}${l}`,         // johndoe
  (f: string, l: string) => `${f[0]}.${l}`,     // j.doe
  (f: string, l: string) => `${l}`,             // doe
  (f: string, l: string) => `${l}.${f}`,        // doe.john
];

export class HunterScraper implements Scraper {
  name = 'hunter' as const;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.hunter.io/v2',
      timeout: 10000,
    });
  }

  private get hasApiKey(): boolean {
    return !!process.env['HUNTER_API_KEY'];
  }

  async isAvailable(): Promise<boolean> {
    return true; // always available — web/pattern fallback used without API key
  }

  async scrape(_query: ScrapeQuery): Promise<RawResult[]> {
    logger.warn('[hunter] Use enrichDomain() directly. scrape() not supported.');
    return [];
  }

  // ── Public enrichment API ─────────────────────────────────────────────────

  async enrichDomain(domain: string): Promise<RawResult | null> {
    if (this.hasApiKey) {
      const result = await this.enrichDomainViaApi(domain);
      if (result) return result;
    }
    return this.enrichDomainViaWeb(domain);
  }

  async verifyEmail(email: string): Promise<{ valid: boolean; confidence: number }> {
    if (this.hasApiKey) {
      try {
        const res = await this.client.get<{
          data: { result: string; score: number };
        }>('/email-verifier', {
          params: { email, api_key: process.env['HUNTER_API_KEY'] },
        });
        const { result, score } = res.data.data;
        return { valid: result === 'deliverable', confidence: score / 100 };
      } catch (err) {
        logger.warn({ err, email }, '[hunter] API email verify failed — using SMTP');
      }
    }
    // Fallback: SMTP probe via emailVerifier
    const result = await emailVerifier.verify(email);
    return { valid: result.valid, confidence: result.confidence };
  }

  async findEmail(
    firstName: string,
    lastName: string,
    domain: string,
  ): Promise<{ email: string; confidence: number } | null> {
    if (this.hasApiKey) {
      try {
        const res = await this.client.get<{
          data: { email: string; score: number };
        }>('/email-finder', {
          params: {
            domain,
            first_name: firstName,
            last_name:  lastName,
            api_key:    process.env['HUNTER_API_KEY'],
          },
        });
        const { email, score } = res.data.data;
        logger.info({ email, score, domain }, '[hunter:api] Email found');
        return { email, confidence: score / 100 };
      } catch (err) {
        logger.warn({ err, domain }, '[hunter:api] findEmail failed — trying pattern fallback');
      }
    }
    return this.findEmailViaPatterns(firstName, lastName, domain);
  }

  // ── API mode ──────────────────────────────────────────────────────────────

  private async enrichDomainViaApi(domain: string): Promise<RawResult | null> {
    logger.info({ domain }, '[hunter:api] Domain search start');
    try {
      const res = await this.client.get<{
        data: {
          domain: string;
          pattern: string;
          emails: Array<{
            value: string; type: string; confidence: number;
            first_name: string; last_name: string;
            position: string; linkedin: string;
          }>;
        };
      }>('/domain-search', {
        params: { domain, api_key: process.env['HUNTER_API_KEY'], limit: 20 },
      });

      const { data } = res.data;
      logger.info({ domain, pattern: data.pattern, count: data.emails.length }, '[hunter:api] Done');

      const contacts: Partial<RawContact>[] = data.emails
        .filter(e => e.confidence >= 50)
        .map(e => ({
          fullName:        `${e.first_name} ${e.last_name}`.trim(),
          firstName:       e.first_name,
          lastName:        e.last_name,
          email:           e.value,
          emailConfidence: e.confidence / 100,
          role:            resolveRole(e.position),
          linkedinUrl:     e.linkedin,
          companyDomain:   domain,
        }));

      return { source: 'hunter', company: { domain } as Partial<RawCompany>, contacts, scrapedAt: new Date() };
    } catch (err) {
      logger.warn({ err, domain }, '[hunter:api] enrichDomain failed — falling back to web');
      return null;
    }
  }

  // ── Web scraping fallback ─────────────────────────────────────────────────
  // Scrapes hunter.io/domain-search — shows limited public results without login

  private async enrichDomainViaWeb(domain: string): Promise<RawResult | null> {
    const browserId = `hunter-${generateRunId()}`;
    logger.info({ domain }, '[hunter:web] Domain search via Playwright');

    try {
      const proxy = proxyManager.getProxy();
      const context = await browserManager.createContext(browserId, proxy ? { proxy } : {});
      const page = await browserManager.newPage(context);

      await page.goto(`https://hunter.io/domain-search/${domain}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await browserManager.humanDelay(2000, 4000);

      if (await browserManager.detectCaptcha(page)) {
        logger.warn({ domain }, '[hunter:web] CAPTCHA — skipping');
        await context.close();
        await browserManager.closeBrowser(browserId);
        return null;
      }

      // Wait for email rows to render (public results visible without login)
      await page.waitForSelector('[class*="email"], .email-result, [data-email]', {
        timeout: 10000,
      }).catch(() => {
        logger.debug({ domain }, '[hunter:web] No email rows found in DOM');
      });

      await browserManager.humanScroll(page, 3);

      const rowLocator = page.locator('[class*="email-item"], .email-result, [data-email]');
      const rowCount = await rowLocator.count();

      const contacts: Array<{ email: string; firstName: string; lastName: string; position: string; confidence: number }> = [];

      for (let i = 0; i < rowCount; i++) {
        const row = rowLocator.nth(i);
        const emailEl    = row.locator('[class*="email-address"], [data-email]').first();
        const nameEl     = row.locator('[class*="name"], .person-name').first();
        const positionEl = row.locator('[class*="position"], [class*="title"]').first();
        const confEl     = row.locator('[class*="confidence"], [class*="score"]').first();

        const emailText  = ((await emailEl.textContent().catch(() => '')) ?? '').trim();
        const emailAttr  = (await emailEl.getAttribute('data-email').catch(() => '')) ?? '';
        const email      = emailText || emailAttr;
        if (!email || !email.includes('@')) continue;

        const fullName   = ((await nameEl.textContent().catch(() => '')) ?? '').trim().split(' ');
        const position   = ((await positionEl.textContent().catch(() => '')) ?? '').trim();
        const confText   = ((await confEl.textContent().catch(() => '50')) ?? '50').replace('%', '');
        const confidence = Math.max(parseInt(confText, 10) || 50, 50);

        contacts.push({
          email,
          firstName:  fullName[0] ?? '',
          lastName:   fullName[fullName.length - 1] ?? '',
          position,
          confidence,
        });
      }

      await context.close();
      await browserManager.closeBrowser(browserId);

      if (!contacts.length) {
        logger.debug({ domain }, '[hunter:web] No public contacts found — nothing to return');
        return null;
      }

      logger.info({ domain, found: contacts.length }, '[hunter:web] Contacts scraped');

      const rawContacts: Partial<RawContact>[] = contacts.map(c => ({
        fullName:        `${c.firstName} ${c.lastName}`.trim(),
        firstName:       c.firstName,
        lastName:        c.lastName,
        email:           c.email,
        emailConfidence: c.confidence / 100,
        role:            resolveRole(c.position),
        companyDomain:   domain,
      }));

      return { source: 'hunter', company: { domain } as Partial<RawCompany>, contacts: rawContacts, scrapedAt: new Date() };
    } catch (err) {
      logger.error({ err, domain }, '[hunter:web] Scrape failed');
      await browserManager.closeBrowser(browserId);
      return null;
    }
  }

  // ── Email pattern + SMTP fallback ─────────────────────────────────────────
  // Generates common email patterns and probes via SMTP to find valid one.

  private async findEmailViaPatterns(
    firstName: string,
    lastName: string,
    domain: string,
  ): Promise<{ email: string; confidence: number } | null> {
    const f = firstName.toLowerCase().replace(/[^a-z]/g, '');
    const l = lastName.toLowerCase().replace(/[^a-z]/g, '');

    if (!f || !l) return null;

    logger.info({ firstName, lastName, domain }, '[hunter:pattern] Trying email patterns via SMTP');

    for (const pattern of EMAIL_PATTERNS) {
      const local = pattern(f, l);
      const email = `${local}@${domain}`;

      try {
        const result = await emailVerifier.verify(email);
        if (result.valid && result.confidence >= 0.6) {
          logger.info({ email, confidence: result.confidence }, '[hunter:pattern] Valid email found');
          return { email, confidence: result.confidence };
        }
      } catch {
        // continue to next pattern
      }
    }

    logger.debug({ firstName, lastName, domain }, '[hunter:pattern] No valid pattern found');
    return null;
  }
}

function resolveRole(position: string): import('@genlea/shared').ContactRole {
  const p = (position ?? '').toLowerCase();
  if (/ceo|chief executive|founder/.test(p)) return 'CEO';
  if (/cto|chief tech/.test(p)) return 'CTO';
  if (/hr|recruiter|talent|people/.test(p)) return 'HR';
  return 'Unknown';
}

export const hunterScraper = new HunterScraper();
