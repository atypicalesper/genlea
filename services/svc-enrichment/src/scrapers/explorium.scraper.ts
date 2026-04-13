/**
 * Explorium enrichment scraper.
 *
 * 2-step API pattern:
 *   1. Match  — POST /v1/businesses/match        → business_id
 *   2. Enrich — firmographics + technographics + funding (parallel)
 *              + prospect search + contacts_information bulk_enrich
 *
 * Env: EXPLORIUM_API_KEY
 * Auth header: api_key: <key>   (NOT Bearer)
 */

import axios, { AxiosInstance } from 'axios';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact, FundingStage,
} from '@genlea/shared';
import { normalizeRole } from '@genlea/shared';
import { logger } from '@genlea/shared';

// ── Helpers ───────────────────────────────────────────────────────────────────

function empRangeToNumber(range: string | undefined): number | undefined {
  if (!range) return undefined;
  const map: Record<string, number> = {
    '1-10': 5, '11-50': 30, '51-200': 125,
    '201-500': 350, '501-1000': 750,
    '1001-5000': 3000, '5001-10000': 7500, '10001+': 15000,
  };
  return map[range];
}

function toFundingStage(roundType: string | undefined): FundingStage | undefined {
  if (!roundType) return undefined;
  const t = roundType.toLowerCase().replace(/[_]/g, ' ');
  if (t.includes('pre seed') || t.includes('pre-seed')) return 'Pre-seed';
  if (/\bseed\b/.test(t)) return 'Seed';
  if (/series a/.test(t)) return 'Series A';
  if (/series b/.test(t)) return 'Series B';
  if (/series c/.test(t)) return 'Series C';
  if (/series d/.test(t) || /series [e-z]/.test(t)) return 'Series D+';
  if (/ipo|public/.test(t)) return 'Public';
  if (/acqui/.test(t)) return 'Acquired';
  if (/boot|self.?fund/.test(t)) return 'Bootstrapped';
  return undefined;
}

// ── Internal response types ───────────────────────────────────────────────────

interface FirmographicsData {
  name?: string;
  number_of_employees_range?: string;
  country_name?: string;
  region_name?: string;
  city_name?: string;
  linkedin_profile?: string;
  linkedin_industry_category?: string;
  business_description?: string;
}

interface TechnographicsData {
  full_tech_stack?: string[];
  prog_langs_and_frameworks?: string[];
  devops_and_development?: string[];
}

interface FundingData {
  last_funding_round_type?: string;
  known_funding_total_value?: number;
  last_funding_round_value_usd?: number;
  investors?: string[];
}

interface ProspectResult {
  prospect_id: string;
  full_name?: string;
  job_title?: string;
  linkedin?: string;
  job_seniority_level?: string;
  job_department?: string;
}

interface ContactInfoResult {
  prospect_id: string;
  professions_email?: string;
  professional_email_status?: 'valid' | 'catch-all' | 'invalid';
  mobile_phone?: string;
  phone_numbers?: Array<{ phone_number: string; type?: string }>;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class ExploriumScraper implements Scraper {
  name = 'explorium' as const;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.explorium.ai',
      timeout: 20_000,
      headers: { 'Content-Type': 'application/json' },
    });

    // Inject API key on every request
    this.client.interceptors.request.use(cfg => {
      const key = process.env['EXPLORIUM_API_KEY'];
      if (key) cfg.headers['api_key'] = key;
      return cfg;
    });
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env['EXPLORIUM_API_KEY'];
  }

  /**
   * Discovery mode — searches Explorium's company database by tech stack + size.
   * Keywords are mapped to tech stack filters; location defaults to US.
   */
  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    if (!process.env['EXPLORIUM_API_KEY']) return [];

    const techTerms = keywordsToTechStack(query.keywords);
    const limit     = Math.min(query.limit ?? 25, 500);

    try {
      // Search companies by tech stack + company size + US
      const searchRes = await this.client.post<{
        data: Array<{
          business_id: string;
          name?: string;
          website?: string;
          domain?: string;
          linkedin_profile?: string;
          number_of_employees_range?: string;
          country_name?: string;
        }>;
        total_results?: number;
      }>('/v1/businesses', {
        country_code:            'US',
        company_size:            ['11-50', '51-200'],          // 10–200 employees
        linkedin_category:       'software',
        ...(techTerms.length && { company_tech_stack_tech: techTerms }),
        page_size: Math.min(limit * 2, 100),                   // over-fetch — some will be deduped
      });

      const businesses = searchRes.data.data ?? [];
      if (!businesses.length) return [];

      // Bulk enrich firmographics + tech for the top results
      const ids = businesses.slice(0, limit).map(b => b.business_id);
      const [firmBulk, techBulk] = await Promise.allSettled([
        this.client.post<{ data: Array<{ business_id: string; data: FirmographicsData }> }>(
          '/v1/businesses/firmographics/bulk_enrich', { business_ids: ids }
        ),
        this.client.post<{ data: Array<{ business_id: string; data: TechnographicsData }> }>(
          '/v1/businesses/technographics/bulk_enrich', { business_ids: ids }
        ),
      ]);

      const firmMap = new Map<string, FirmographicsData>(
        firmBulk.status === 'fulfilled'
          ? (firmBulk.value.data.data ?? []).map(r => [r.business_id, r.data])
          : []
      );
      const techMap = new Map<string, TechnographicsData>(
        techBulk.status === 'fulfilled'
          ? (techBulk.value.data.data ?? []).map(r => [r.business_id, r.data])
          : []
      );

      const results: RawResult[] = businesses.slice(0, limit).map(b => {
        const firm = firmMap.get(b.business_id) ?? {};
        const tech = techMap.get(b.business_id) ?? {};
        const domain = b.domain
          ?? b.website?.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
          ?? '';

        const techStack = [
          ...(tech.prog_langs_and_frameworks ?? []),
          ...(tech.devops_and_development ?? []),
        ].map(t => t.toLowerCase()).filter((t, i, a) => a.indexOf(t) === i).slice(0, 20);

        const rawCompany: Partial<RawCompany> = {
          name:          firm.name ?? b.name,
          domain,
          description:   firm.business_description,
          employeeCount: empRangeToNumber(firm.number_of_employees_range ?? b.number_of_employees_range),
          hqCountry:     firm.country_name ?? b.country_name ?? 'US',
          hqState:       firm.region_name,
          hqCity:        firm.city_name,
          linkedinUrl:   firm.linkedin_profile ?? b.linkedin_profile,
          industry:      firm.linkedin_industry_category ? [firm.linkedin_industry_category] : [],
          techStack,
        };

        return { source: 'explorium' as const, company: rawCompany, scrapedAt: new Date() };
      }).filter(r => r.company?.domain);

      logger.info({ keywords: query.keywords, found: results.length }, '[explorium:discovery] Companies found');
      return results;
    } catch (err) {
      logger.error({ err, keywords: query.keywords }, '[explorium:discovery] scrape failed');
      return [];
    }
  }

  // ── Main public method ────────────────────────────────────────────────────

  async enrichDomain(domain: string, companyName?: string): Promise<RawResult | null> {
    if (!process.env['EXPLORIUM_API_KEY']) {
      logger.debug({ domain }, '[explorium] No API key — skipping');
      return null;
    }

    try {
      // Step 1: Match → get internal business_id
      const businessId = await this.matchBusiness(domain, companyName);
      if (!businessId) {
        logger.debug({ domain }, '[explorium] Company not matched in database');
        return null;
      }
      logger.debug({ domain, businessId }, '[explorium] Business matched');

      // Step 2: Enrich company data in parallel
      const [firmRes, techRes, fundRes] = await Promise.allSettled([
        this.enrichFirmographics(businessId),
        this.enrichTechnographics(businessId),
        this.enrichFunding(businessId),
      ]);

      const firm = firmRes.status === 'fulfilled' ? firmRes.value : null;
      const tech = techRes.status === 'fulfilled' ? techRes.value : null;
      const fund = fundRes.status === 'fulfilled' ? fundRes.value : null;

      // Step 3: Find decision-maker contacts with emails + phones
      const contacts = await this.findContacts(businessId, domain);

      // Build tech stack: prefer languages/frameworks first, then fill from full stack
      const techStack = [
        ...(tech?.prog_langs_and_frameworks ?? []),
        ...(tech?.devops_and_development ?? []),
        ...(tech?.full_tech_stack ?? []),
      ]
        .map(t => t.toLowerCase())
        .filter((t, i, a) => a.indexOf(t) === i) // dedupe
        .slice(0, 30);

      const rawCompany: Partial<RawCompany> = {
        domain,
        name:            firm?.name ?? companyName,
        description:     firm?.business_description,
        employeeCount:   empRangeToNumber(firm?.number_of_employees_range),
        hqCountry:       firm?.country_name,
        hqState:         firm?.region_name,
        hqCity:          firm?.city_name,
        linkedinUrl:     firm?.linkedin_profile,
        industry:        firm?.linkedin_industry_category ? [firm.linkedin_industry_category] : [],
        techStack,
        fundingStage:    toFundingStage(fund?.last_funding_round_type),
        fundingTotalUsd: fund?.known_funding_total_value ?? fund?.last_funding_round_value_usd,
      };

      logger.info({
        domain,
        employees: rawCompany.employeeCount,
        techCount: techStack.length,
        contacts:  contacts.length,
        funding:   rawCompany.fundingStage,
      }, '[explorium] Enrichment complete');

      return {
        source:    'explorium',
        company:   rawCompany,
        contacts,
        scrapedAt: new Date(),
      };
    } catch (err) {
      logger.error({ err, domain }, '[explorium] enrichDomain failed');
      return null;
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async matchBusiness(domain: string, name?: string): Promise<string | null> {
    try {
      const res = await this.client.post<{
        matched_businesses: Array<{ business_id: string; match_level?: string }>;
      }>('/v1/businesses/match', {
        businesses_to_match: [{ domain, ...(name && { name }) }],
      });
      return res.data.matched_businesses?.[0]?.business_id ?? null;
    } catch (err) {
      logger.warn({ err, domain }, '[explorium] matchBusiness failed');
      return null;
    }
  }

  private async enrichFirmographics(businessId: string): Promise<FirmographicsData | null> {
    const res = await this.client.post<{ data: FirmographicsData }>(
      '/v1/businesses/firmographics/enrich',
      { business_id: businessId },
    );
    return res.data.data ?? null;
  }

  private async enrichTechnographics(businessId: string): Promise<TechnographicsData | null> {
    const res = await this.client.post<{ data: TechnographicsData }>(
      '/v1/businesses/technographics/enrich',
      { business_id: businessId },
    );
    return res.data.data ?? null;
  }

  private async enrichFunding(businessId: string): Promise<FundingData | null> {
    const res = await this.client.post<{ data: FundingData }>(
      '/v1/businesses/funding_and_acquisition/enrich',
      { business_id: businessId },
    );
    return res.data.data ?? null;
  }

  private async findContacts(businessId: string, domain: string): Promise<Partial<RawContact>[]> {
    try {
      // Search decision-makers: C-suite, VP, Director, Founder with confirmed emails
      const searchRes = await this.client.post<{ data: ProspectResult[]; total_results?: number }>(
        '/v1/prospects',
        {
          business_id:    businessId,
          job_level:      ['c-suite', 'vice president', 'director', 'founder', 'owner'],
          job_department: ['engineering', 'c-suite', 'human resources'],
          has_email:      { value: true },
          page_size:      25,
        },
      );

      const prospects = searchRes.data.data ?? [];
      if (!prospects.length) {
        logger.debug({ domain }, '[explorium] No prospects found');
        return [];
      }

      logger.debug({ domain, count: prospects.length }, '[explorium] Prospects found');

      // Bulk enrich contact info: emails + phone numbers
      const prospectIds = prospects.map(p => p.prospect_id);
      const contactRes = await this.client.post<{ data: ContactInfoResult[] }>(
        '/v1/prospects/contacts_information/bulk_enrich',
        { prospect_ids: prospectIds },
      );

      const infoMap = new Map<string, ContactInfoResult>(
        (contactRes.data.data ?? []).map(c => [c.prospect_id, c]),
      );

      // Merge search results + contact info → RawContact[]
      return prospects
        .map((p): Partial<RawContact> | null => {
          const info  = infoMap.get(p.prospect_id);
          const role  = normalizeRole(p.job_title);
          if (role === 'Unknown') return null; // only save known decision-makers

          const email = info?.professions_email ?? undefined;
          const phone = info?.mobile_phone
            ?? info?.phone_numbers?.find(n => n.type === 'mobile')?.phone_number
            ?? info?.phone_numbers?.[0]?.phone_number
            ?? undefined;

          const emailConfidence = info?.professional_email_status === 'valid'     ? 0.95
                                : info?.professional_email_status === 'catch-all' ? 0.6
                                : email ? 0.5 : 0;

          return {
            fullName:        p.full_name ?? '',
            firstName:       p.full_name?.split(' ')[0],
            lastName:        p.full_name?.split(' ').at(-1),
            role,
            email,
            emailConfidence,
            phone,
            linkedinUrl:     p.linkedin,
            companyDomain:   domain,
          };
        })
        .filter((c): c is Partial<RawContact> => c !== null && !!c.fullName);
    } catch (err) {
      logger.warn({ err, businessId, domain }, '[explorium] findContacts failed');
      return [];
    }
  }
}

export const exploriumScraper = new ExploriumScraper();

// ── Keyword → Explorium tech stack names ─────────────────────────────────────

const TECH_MAP: Record<string, string[]> = {
  nodejs:         ['Node.js', 'JavaScript'],
  node:           ['Node.js', 'JavaScript'],
  javascript:     ['JavaScript'],
  typescript:     ['TypeScript'],
  python:         ['Python'],
  react:          ['React'],
  nextjs:         ['Next.js', 'React'],
  nestjs:         ['NestJS', 'Node.js'],
  vue:            ['Vue.js'],
  angular:        ['Angular'],
  django:         ['Django', 'Python'],
  fastapi:        ['FastAPI', 'Python'],
  flask:          ['Flask', 'Python'],
  golang:         ['Go'],
  go:             ['Go'],
  java:           ['Java'],
  kotlin:         ['Kotlin'],
  ruby:           ['Ruby on Rails', 'Ruby'],
  rails:          ['Ruby on Rails'],
  rust:           ['Rust'],
  swift:          ['Swift'],
  aws:            ['Amazon Web Services'],
  docker:         ['Docker'],
  kubernetes:     ['Kubernetes'],
  graphql:        ['GraphQL'],
  postgres:       ['PostgreSQL'],
  mongodb:        ['MongoDB'],
  redis:          ['Redis'],
  ai:             ['Python', 'TensorFlow', 'PyTorch'],
  ml:             ['Python', 'TensorFlow', 'PyTorch'],
  'generative-ai':['Python', 'OpenAI', 'LangChain'],
  llm:            ['Python', 'OpenAI', 'LangChain'],
  saas:           ['JavaScript', 'TypeScript'],
};

function keywordsToTechStack(keywords: string): string[] {
  const words = keywords.toLowerCase().split(/[\s,]+/);
  const result = new Set<string>();
  for (const word of words) {
    const mapped = TECH_MAP[word];
    if (mapped) mapped.forEach(t => result.add(t));
  }
  return [...result].slice(0, 5); // Explorium recommends ≤5 tech filters
}
