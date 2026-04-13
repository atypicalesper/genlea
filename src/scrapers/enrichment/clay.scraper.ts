import axios, { AxiosInstance } from 'axios';
import type { Scraper, ScrapeQuery, RawResult, RawCompany, RawContact } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Clay enrichment scraper.
 * Uses Clay's REST API to fetch company metadata and decision-maker contacts.
 * Requires CLAY_API_KEY.
 *
 * API docs: https://docs.clay.com/api-reference
 */
export class ClayEnrichmentScraper implements Scraper {
  name = 'clay' as const;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.clay.com/v1',
      timeout: 15_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Inject API key on every request
    this.client.interceptors.request.use(cfg => {
      const key = process.env['CLAY_API_KEY'];
      if (key) cfg.headers['x-clay-api-key'] = key;
      return cfg;
    });
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env['CLAY_API_KEY'];
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const apiKey = process.env['CLAY_API_KEY'];
    if (!apiKey) return [];

    logger.info({ keywords: query.keywords }, '[clay] Discovery search');

    try {
      const res = await this.client.post<ClayCompanySearchResponse>('/companies/search', {
        query:          query.keywords,
        employee_range: { min: 10, max: 300 },
        limit:          query.limit ?? 25,
        filters: {
          country: 'US',
        },
      });

      const companies = res.data.results ?? [];
      logger.info({ found: companies.length }, '[clay] Discovery done');

      return companies.map((c): RawResult => ({
        source:    'clay',
        company: {
          name:          c.name,
          domain:        c.domain,
          websiteUrl:    c.website ?? (c.domain ? `https://${c.domain}` : undefined),
          employeeCount: c.employee_count ?? c.headcount,
          fundingStage:  normalizeFunding(c.funding_stage) as import('../../types/index.js').FundingStage | undefined,
          hqCountry:     c.country ?? 'US',
          techStack:     (c.technologies ?? []).map((t: string) => t.toLowerCase()),
          linkedinUrl:   c.linkedin_url,
        },
        contacts:  [],
        jobs:      [],
        scrapedAt: new Date(),
      }));
    } catch (err) {
      logger.warn({ err, keywords: query.keywords }, '[clay] Discovery search failed');
      return [];
    }
  }

  // ── Company enrichment ──────────────────────────────────────────────────────

  async enrichDomain(domain: string, companyName?: string): Promise<RawResult | null> {
    const apiKey = process.env['CLAY_API_KEY'];
    if (!apiKey) return null;

    logger.info({ domain }, '[clay] Enriching company');

    try {
      // Company profile enrichment
      const companyRes = await this.client.post<ClayCompanyResponse>('/company-profile', {
        domain,
        ...(companyName ? { name: companyName } : {}),
      });

      const cd = companyRes.data;
      const company: Partial<RawCompany> = {
        domain,
        name:          cd.name ?? companyName,
        websiteUrl:    cd.website ?? `https://${domain}`,
        employeeCount: cd.employee_count ?? cd.headcount,
        fundingStage:  normalizeFunding(cd.funding_stage ?? cd.last_funding_type) as import('../../types/index.js').FundingStage | undefined,
        hqCountry:     cd.country ?? cd.hq_country,
        industry:      cd.industry ? [cd.industry] : [],
        techStack:     (cd.technologies ?? []).map(t => t.toLowerCase()),
        linkedinUrl:   cd.linkedin_url,
        githubOrg:     cd.github,
      };

      // People enrichment — decision-makers at this domain
      const peopleRes = await this.client.post<ClayPeopleResponse>('/people-search', {
        domain,
        titles: [
          'CEO', 'CTO', 'Co-Founder', 'Founder',
          'VP of Engineering', 'Head of Engineering', 'Director of Engineering',
          'VP Engineering', 'Engineering Manager',
          'HR', 'Head of Talent', 'Head of People', 'Recruiter', 'People Operations',
          'COO', 'CPO', 'CFO',
        ],
        limit: 15,
      }).catch(() => ({ data: { results: [] } }));

      const contacts: Partial<RawContact>[] = (peopleRes.data.results ?? [])
        .filter(p => p.full_name)
        .map(p => ({
          fullName:        p.full_name,
          firstName:       p.first_name,
          lastName:        p.last_name,
          email:           p.email,
          emailConfidence: p.email_confidence != null ? p.email_confidence / 100 : undefined,
          phone:           p.phone,
          linkedinUrl:     p.linkedin_url,
          role:            resolveRole(p.title ?? ''),
          companyDomain:   domain,
          sources:         ['clay' as const],
        }));

      logger.info({ domain, contacts: contacts.length, hasCompany: !!cd.name }, '[clay] Enrichment complete');
      return { source: 'clay', company, contacts, scrapedAt: new Date() };

    } catch (err) {
      const status = (err as any)?.response?.status;
      if (status === 401 || status === 403) {
        logger.error({ domain, status }, '[clay] Auth error — check CLAY_API_KEY');
      } else if (status === 404) {
        logger.debug({ domain }, '[clay] No company found for domain');
      } else {
        logger.warn({ err, domain }, '[clay] Enrichment failed');
      }
      return null;
    }
  }
}

// ── Role normalisation ────────────────────────────────────────────────────────

function resolveRole(title: string): import('../../types/index.js').ContactRole {
  const t = title.toLowerCase();
  if (/\bceo\b|chief exec|founder/.test(t))           return 'CEO';
  if (/\bcto\b|chief tech/.test(t))                   return 'CTO';
  if (/\bcoo\b|chief oper/.test(t))                   return 'COO';
  if (/\bcpo\b|chief product/.test(t))                return 'CPO';
  if (/\bcfo\b|chief financial/.test(t))              return 'CFO';
  if (/vp.*eng|head.*eng|dir.*eng|eng.*manager/.test(t)) return 'VP of Engineering';
  if (/recruiter|talent|head.*people|people ops/.test(t)) return 'Recruiter';
  if (/\bhr\b|human res/.test(t))                     return 'HR';
  return 'Unknown';
}

function normalizeFunding(raw?: string): string | undefined {
  if (!raw) return undefined;
  const r = raw.toLowerCase();
  if (r.includes('seed'))       return 'Seed';
  if (r.includes('pre'))        return 'Pre-seed';
  if (r.includes('series_a') || r === 'a') return 'Series A';
  if (r.includes('series_b') || r === 'b') return 'Series B';
  if (r.includes('series_c') || r === 'c') return 'Series C';
  if (r.includes('series_d') || r === 'd') return 'Series D+';
  if (r.includes('bootstrap')) return 'Bootstrapped';
  return raw;
}

// ── Response shapes ───────────────────────────────────────────────────────────

interface ClayCompanySearchResult {
  name?:           string;
  domain?:         string;
  website?:        string;
  employee_count?: number;
  headcount?:      number;
  funding_stage?:  string;
  country?:        string;
  technologies?:   string[];
  linkedin_url?:   string;
}

interface ClayCompanySearchResponse {
  results: ClayCompanySearchResult[];
  total?:  number;
}

interface ClayCompanyResponse {
  name?:              string;
  website?:           string;
  employee_count?:    number;
  headcount?:         number;
  funding_stage?:     string;
  last_funding_type?: string;
  country?:           string;
  hq_country?:        string;
  industry?:          string;
  technologies?:      string[];
  linkedin_url?:      string;
  github?:            string;
}

interface ClayPerson {
  full_name?:        string;
  first_name?:       string;
  last_name?:        string;
  title?:            string;
  email?:            string;
  email_confidence?: number;
  phone?:            string;
  linkedin_url?:     string;
}

interface ClayPeopleResponse {
  results: ClayPerson[];
}

export const clayScraper = new ClayEnrichmentScraper();
