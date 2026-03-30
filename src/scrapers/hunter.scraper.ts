import axios, { AxiosInstance } from 'axios';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

export class HunterScraper implements Scraper {
  name = 'hunter' as const;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.hunter.io/v2',
      timeout: 10000,
    });
  }

  async isAvailable(): Promise<boolean> {
    if (!process.env['HUNTER_API_KEY']) {
      logger.warn('[hunter] HUNTER_API_KEY not set');
      return false;
    }
    return true;
  }

  async scrape(_query: ScrapeQuery): Promise<RawResult[]> {
    // Hunter is used in enrichment mode — pass a domain directly
    logger.warn('[hunter] Use enrichDomain() directly. scrape() not supported.');
    return [];
  }

  /**
   * Find email pattern + all contacts for a specific domain.
   * Called directly from the enrichment worker, not via the scrape pipeline.
   */
  async enrichDomain(domain: string): Promise<RawResult | null> {
    if (!(await this.isAvailable())) return null;

    logger.info({ domain }, '[hunter] Domain search start');

    try {
      const res = await this.client.get<{
        data: {
          domain: string;
          pattern: string;
          emails: Array<{
            value: string;
            type: string;
            confidence: number;
            first_name: string;
            last_name: string;
            position: string;
            linkedin: string;
          }>;
        };
      }>('/domain-search', {
        params: { domain, api_key: process.env['HUNTER_API_KEY'], limit: 20 },
      });

      const { data } = res.data;
      logger.info(
        { domain, pattern: data.pattern, emailCount: data.emails.length },
        '[hunter] Domain search complete'
      );

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

      logger.debug({ domain, contacts: contacts.length }, '[hunter] Contacts extracted');

      return {
        source: 'hunter',
        company: { domain } as Partial<RawCompany>,
        contacts,
        scrapedAt: new Date(),
      };
    } catch (err) {
      logger.error({ err, domain }, '[hunter] Domain search failed');
      return null;
    }
  }

  /**
   * Verify a specific email address.
   * Returns confidence score (0–1) and whether it's valid.
   */
  async verifyEmail(email: string): Promise<{ valid: boolean; confidence: number }> {
    if (!(await this.isAvailable())) return { valid: false, confidence: 0 };

    logger.debug({ email }, '[hunter] Verifying email');

    try {
      const res = await this.client.get<{
        data: { result: string; score: number; regexp: boolean; gibberish: boolean };
      }>('/email-verifier', {
        params: { email, api_key: process.env['HUNTER_API_KEY'] },
      });

      const { result, score } = res.data.data;
      const valid = result === 'deliverable';
      const confidence = score / 100;

      logger.info({ email, valid, confidence }, '[hunter] Email verification result');
      return { valid, confidence };
    } catch (err) {
      logger.error({ err, email }, '[hunter] Email verification failed');
      return { valid: false, confidence: 0 };
    }
  }

  /**
   * Find email for a specific person at a domain using name pattern.
   */
  async findEmail(
    firstName: string,
    lastName: string,
    domain: string
  ): Promise<{ email: string; confidence: number } | null> {
    if (!(await this.isAvailable())) return null;

    logger.debug({ firstName, lastName, domain }, '[hunter] Finding email by name');

    try {
      const res = await this.client.get<{
        data: { email: string; score: number };
      }>('/email-finder', {
        params: {
          domain,
          first_name: firstName,
          last_name: lastName,
          api_key: process.env['HUNTER_API_KEY'],
        },
      });

      const { email, score } = res.data.data;
      logger.info({ email, score, domain }, '[hunter] Email found');
      return { email, confidence: score / 100 };
    } catch (err) {
      logger.error({ err, firstName, lastName, domain }, '[hunter] Email finder failed');
      return null;
    }
  }
}

function resolveRole(position: string): import('../types/index.js').ContactRole {
  const p = (position ?? '').toLowerCase();
  if (/ceo|chief executive|founder/.test(p)) return 'CEO';
  if (/cto|chief tech/.test(p)) return 'CTO';
  if (/hr|recruiter|talent|people/.test(p)) return 'HR';
  return 'Unknown';
}

export const hunterScraper = new HunterScraper();
