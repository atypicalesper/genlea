/**
 * Discovery Agent
 *
 * Given a search query, the agent autonomously decides:
 *   - Which sources to try (and in what order)
 *   - Whether to expand to more sources if results are thin
 *   - How to handle failures (retry different source, adjust keywords)
 *   - When enough companies have been found
 *
 * Workers call runDiscoveryAgent() — no manual intervention needed.
 */

import { z }                from 'zod';
import { tool }             from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { runAgent }              from './base.agent.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { normalizer, normalizeRole } from '../enrichment/normalizer.js';
import { deduplicateCompanies }      from '../enrichment/deduplicator.js';
import { companyRepository }         from '../storage/repositories/company.repository.js';
import { contactRepository }         from '../storage/repositories/contact.repository.js';
import { scrapeLogRepository }       from '../storage/repositories/scrape-log.repository.js';
import { queueManager }              from '../core/queue.manager.js';
import { normalizeDomain }           from '../utils/random.js';
import { hunterScraper }             from '../scrapers/enrichment/index.js';
import { logger }                    from '../utils/logger.js';
import {
  linkedInScraper, apolloScraper, crunchbaseScraper, wellfoundScraper,
  indeedScraper, glassdoorScraper, surelyRemoteScraper, exploriumScraper,
  zoomInfoScraper,
} from '../scrapers/discovery/index.js';
import type { DiscoveryJobData, Scraper } from '../types/index.js';

// ── Blocklists ────────────────────────────────────────────────────────────────

const BLOCKED_DOMAINS = new Set([
  'google.com','amazon.com','microsoft.com','apple.com','meta.com','facebook.com',
  'netflix.com','salesforce.com','oracle.com','ibm.com','sap.com','adobe.com',
  'intuit.com','paypal.com','ebay.com','uber.com','lyft.com','airbnb.com',
  'twitter.com','x.com','linkedin.com','snap.com','pinterest.com','reddit.com',
  'discord.com','shopify.com','squarespace.com','wix.com','hubspot.com','zendesk.com',
  'atlassian.com','slack.com','zoom.us','dropbox.com','box.com','twilio.com',
  'cloudflare.com','okta.com','datadog.com','splunk.com','crowdstrike.com',
  'pagerduty.com','hashicorp.com','confluent.io','stripe.com','plaid.com',
  'braintree.com','square.com','jpmorganchase.com','jpmorgan.com','chase.com',
  'bankofamerica.com','wellsfargo.com','citigroup.com','goldmansachs.com',
  'morganstanley.com','deloitte.com','pwc.com','kpmg.com','ey.com','accenture.com',
  'infosys.com','tcs.com','wipro.com','cognizant.com','walmart.com','target.com',
]);

const BLOCKED_NAME_PATTERNS = [
  /\bbank\b/i, /\bchase\b/i, /\bmorgan\b/i, /\bfinancial\b/i,
  /\binsurance\b/i, /\bhospital\b/i, /\bhealthcare\b/i,
  /\bdeloitte\b/i, /\baccenture\b/i, /\bcognizant\b/i,
  /\bgovernment\b/i, /\bfederal\b/i, /\bdepartment of\b/i,
];

const SCRAPERS: Record<string, Scraper> = {
  explorium:    exploriumScraper,
  wellfound:    wellfoundScraper,
  linkedin:     linkedInScraper,
  indeed:       indeedScraper,
  crunchbase:   crunchbaseScraper,
  apollo:       apolloScraper,
  glassdoor:    glassdoorScraper,
  surelyremote: surelyRemoteScraper,
  zoominfo:     zoomInfoScraper,
};

const SOURCE_LIST = Object.keys(SCRAPERS).join(', ');

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a B2B lead generation discovery agent for a software agency that sells offshore Indian developer talent to US/UK/CA/AU/EU tech companies.

Your goal: find tech companies with 10–200 employees that are actively hiring software engineers. These are pre-qualified leads because they are in a growth phase and have engineering demand.

Target profile:
- Company size: 10–200 employees
- Age: founded within the last 7 years (2018–present) — includes seed-stage startups AND growth-stage companies 4–7 years old
- Hiring: actively posting software engineering roles in the target tech stack
- Verticals (include variety): SaaS, AI/ML, Fintech, HealthTech, DevTools, B2B Software, EdTech, LegalTech, PropTech, InsurTech, Cybersecurity, MarTech, HRTech, CleanTech, LogisticsTech, E-commerce Tech, Data & Analytics, API Platforms, CRMTech, AgriTech
- Funding: pre-seed to Series C (not bootstrapped micro-businesses or Series D+ mega-rounds)

Available sources: ${SOURCE_LIST}

Hiring status — set hiringInStack per company:
- Job board sources (wellfound, linkedin, indeed, glassdoor, surelyremote): companies returned ARE actively hiring → hiringInStack: true
- Database sources (explorium, crunchbase, apollo): hiring status is unknown → hiringInStack: false (enrichment will verify later)
- If a result includes job titles/open roles that match the target tech stack keywords: hiringInStack: true regardless of source

Decision rules:
1. Always start with the source specified in the task. If it returns < 5 results, automatically try 2–3 other sources with the same or adapted keywords.
2. If a source returns an error or is unavailable, skip it and try the next best source.
3. Good fallback order: explorium → wellfound → linkedin → indeed → glassdoor → crunchbase → apollo → zoominfo → surelyremote
4. explorium uses API-based company search — very reliable, no browser needed. Prefer it when available.
5. Adapt keywords when expanding — e.g. if "startup backend engineer" returns little, try "growth stage tech company software engineer" or "series b saas engineer".
6. Stop when you have ≥ 15 valid companies OR have tried all available sources.
7. Never return large enterprises (banks, consulting firms, FAANG, >200 employees) — the blocklist handles most, but use your judgment.
8. A 5–7 year old company with strong engineering hiring is a better lead than a 1-year-old startup with zero team.
9. Save ALL valid companies — even if not currently hiring in the target stack. These go on a watchlist and will be refreshed automatically.

After collecting results, call save_companies with all discovered companies (set hiringInStack accurately per company).`;

// ── Tool factory ──────────────────────────────────────────────────────────────
// Combines tool schema (Zod) + handler in one place — no separate makeHandlers map.

function makeTools(job: DiscoveryJobData): StructuredToolInterface[] {
  return [
    // ── check_source_availability ─────────────────────────────────────────────
    tool(
      async ({ source }) => {
        const scraper = SCRAPERS[source];
        if (!scraper) return JSON.stringify({ available: false, reason: 'Unknown source' });
        const available = await scraper.isAvailable();
        return JSON.stringify({ available, source });
      },
      {
        name:        'check_source_availability',
        description: 'Check if a scraper source has valid credentials and is available to use.',
        schema: z.object({
          source: z.string().describe(`Source to check. Options: ${SOURCE_LIST}`),
        }),
      },
    ),

    // ── scrape_source ─────────────────────────────────────────────────────────
    tool(
      async ({ source, keywords, location = 'United States', limit = 25 }) => {
        const scraper = SCRAPERS[source];
        if (!scraper) return JSON.stringify({ error: `Unknown source: ${source}`, companies: [] });

        if (!(await scraper.isAvailable())) {
          return JSON.stringify({ error: `${source} is unavailable — missing credentials`, companies: [] });
        }

        try {
          const rawResults = await scraper.scrape({ keywords, location, limit });
          const { companies } = normalizer.processResults(rawResults);
          const deduped = deduplicateCompanies(companies);

          const filtered = deduped.filter(c => {
            if (!c.domain || !c.name) return false;
            if (BLOCKED_DOMAINS.has(c.domain)) return false;
            if (c.name && BLOCKED_NAME_PATTERNS.some(re => re.test(c.name!))) return false;
            if (c.employeeCount && c.employeeCount > 1000) return false;
            return true;
          });

          logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery.agent] Scraped');

          return JSON.stringify({
            source,
            rawCount:      rawResults.length,
            filteredCount: filtered.length,
            // Slim payload — LLM only needs identity + basic signals to reason.
            companies: filtered.map(c => ({
              name:          c.name,
              domain:        c.domain,
              employeeCount: c.employeeCount,
              fundingStage:  c.fundingStage,
              techStack:     (c.techStack ?? []).slice(0, 4),
              source,
            })),
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          logger.warn({ source, err }, '[discovery.agent] Scrape failed');
          return JSON.stringify({ error: msg, companies: [] });
        }
      },
      {
        name:        'scrape_source',
        description: 'Scrape a source for companies matching the query. Returns companies found.',
        schema: z.object({
          source:   z.string().describe(`Source to scrape. Options: ${SOURCE_LIST}`),
          keywords: z.string().describe('Search keywords'),
          location: z.string().default('United States'),
          limit:    z.number().int().min(1).max(100).default(25).describe('Max results to fetch'),
        }),
      },
    ),

    // ── save_companies ────────────────────────────────────────────────────────
    tool(
      async ({ companies }) => {
        let saved = 0, watchlisted = 0, skipped = 0;

        for (const co of companies) {
          const domain = normalizeDomain(co.domain ?? '');
          if (!domain || !co.name) { skipped++; continue; }

          const hiringInStack   = co.hiringInStack !== false;
          const pipelineStatus  = hiringInStack ? 'discovered' : 'watchlist';

          try {
            const company = await companyRepository.upsert({
              name:          co.name,
              domain,
              linkedinUrl:   co.linkedinUrl,
              employeeCount: co.employeeCount,
              fundingStage:  co.fundingStage,
              techStack:     co.techStack,
              hqCountry:     co.hqCountry ?? 'US',
              sources:       [co.source ?? job.source],
              pipelineStatus,
            } as any);

            if (hiringInStack) {
              // Fire-and-forget Hunter contact pre-population
              if (process.env['HUNTER_API_KEY']) {
                hunterScraper.enrichDomain(domain).then(async result => {
                  if (!result?.contacts?.length) return;
                  const valid = result.contacts.filter(c => c.fullName && c.role && normalizeRole(c.role as string) !== 'Unknown');
                  await Promise.allSettled(
                    valid.map(c =>
                      contactRepository.upsert({
                        companyId:       company._id!,
                        fullName:        c.fullName!,
                        firstName:       c.firstName,
                        lastName:        c.lastName,
                        role:            normalizeRole(c.role as string),
                        email:           c.email,
                        emailConfidence: c.emailConfidence ?? 0,
                        linkedinUrl:     c.linkedinUrl,
                        sources:         ['hunter'],
                        forOriginRatio:  false,
                      }).catch(err => logger.debug({ err, domain }, '[discovery.agent] Hunter pre-pop failed'))
                    )
                  );
                }).catch(err => logger.debug({ err, domain }, '[discovery.agent] Hunter pre-pop error'));
              }

              await queueManager.addEnrichmentJob({
                runId:     job.runId,
                companyId: company._id!,
                domain:    company.domain,
                sources:   ['github', 'hunter', 'clearbit'],
              });
              saved++;
            } else {
              watchlisted++;
            }
          } catch { skipped++; }
        }

        logger.info({ saved, watchlisted, skipped }, '[discovery.agent] Companies saved');
        return JSON.stringify({ saved, watchlisted, skipped, total: companies.length });
      },
      {
        name:        'save_companies',
        description: 'Save all valid discovered companies to the database. Companies actively hiring in the target stack are queued for enrichment; others go on a watchlist for later refresh. Call once when done collecting.',
        schema: z.object({
          companies: z.array(z.object({
            name:          z.string(),
            domain:        z.string(),
            linkedinUrl:   z.string().optional(),
            employeeCount: z.number().optional(),
            fundingStage:  z.string().optional(),
            techStack:     z.array(z.string()).optional(),
            hqCountry:     z.string().optional(),
            source:        z.string().optional(),
            hiringInStack: z.boolean().optional().describe('True if company is confirmed to be actively hiring in the target tech stack'),
          })).describe('Array of company objects to save'),
        }),
      },
    ),
  ];
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runDiscoveryAgent(job: DiscoveryJobData): Promise<void> {
  const { runId, source, query } = job;

  const logId = (await scrapeLogRepository.create({
    runId, scraper: source, status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt: new Date(),
  }))._id!;

  const startedAt = Date.now();

  const userMessage = `
Find tech companies for B2B lead generation.

Primary source: ${source}
Keywords: ${query.keywords}
Location: ${query.location ?? 'United States'}
Target limit: ${query.limit ?? 25} companies

Start with ${source}. If you get fewer than 5 results or it fails, expand to other sources using similar keywords.
Prefer companies in: SaaS, AI/ML, BioTech, Fintech, HealthTech, DevTools.
Target size: 10–200 employees. Age: founded 2018–present (up to ~7 years old). Funding: pre-seed to Series C.
A company founded 5–6 years ago that's actively hiring engineers is a perfect lead — do not skip it just because it's not "early stage".
`.trim();

  try {
    const result = await runAgent({
      name:          `discovery:${source}:${runId.slice(0, 8)}`,
      systemPrompt:  SYSTEM_PROMPT,
      tools:         makeTools(job),
      userMessage,
      maxIterations: 12,
    });

    const saveResult = result.toolResults.get('save_companies') as { saved?: number } | undefined;
    const saved = saveResult?.saved ?? 0;

    await scrapeLogRepository.complete(logId, {
      status: 'success',
      companiesFound: saved,
      contactsFound:  0,
      jobsFound:      0,
      errors:         [],
      durationMs:     Date.now() - startedAt,
    });

    logger.info({ runId, source, saved, iterations: result.iterations }, '[discovery.agent] Complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound: 0, contactsFound: 0, jobsFound: 0,
      errors: [msg], durationMs: Date.now() - startedAt,
    }).catch(() => {});
    logger.error({ err, runId, source }, '[discovery.agent] Failed');
    await alertAgentFailure({ agent: `discovery:${source}`, runId, error: err });
    throw err;
  }
}
