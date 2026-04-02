/**
 * Discovery Agent
 *
 * Given a search query, the agent decides:
 *   - Which sources to try (and in what order)
 *   - Whether to expand to more sources if results are thin
 *   - How to handle failures (retry different source, adjust keywords)
 *   - When enough companies have been found
 *
 * Workers call runDiscoveryAgent() instead of hardcoded scraper logic.
 */

import { runAgent, AgentConfig, ToolDef, ToolHandler } from './base.agent.js';
import { normalizer, normalizeRole } from '../enrichment/normalizer.js';
import { deduplicateCompanies } from '../enrichment/deduplicator.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { scrapeLogRepository } from '../storage/repositories/scrape-log.repository.js';
import { queueManager } from '../core/queue.manager.js';
import { normalizeDomain } from '../utils/random.js';
import { hunterScraper } from '../scrapers/enrichment/index.js';
import { logger } from '../utils/logger.js';
import {
  linkedInScraper, apolloScraper, crunchbaseScraper, wellfoundScraper,
  indeedScraper, glassdoorScraper, surelyRemoteScraper, exploriumScraper,
} from '../scrapers/discovery/index.js';
import type { DiscoveryJobData, Scraper } from '../types/index.js';

// ── Blocklists (shared with discovery worker) ─────────────────────────────────
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
};

const SYSTEM_PROMPT = `You are a B2B lead generation discovery agent for a software agency that sells offshore Indian developer talent to US/UK/CA/AU/EU tech companies.

Your goal: find tech companies with 10–200 employees that are actively hiring software engineers. These are pre-qualified leads because they are in a growth phase and have engineering demand.

Target profile:
- Company size: 10–200 employees
- Age: founded within the last 7 years (2018–present) — includes seed-stage startups AND growth-stage companies 4–7 years old
- Hiring: actively posting software engineering roles in the target tech stack
- Verticals (include variety): SaaS, AI/ML, Fintech, HealthTech, DevTools, B2B Software, EdTech, LegalTech, PropTech, InsurTech, Cybersecurity, MarTech, HRTech, CleanTech, LogisticsTech, E-commerce Tech, Data & Analytics, API Platforms, CRMTech, AgriTech
- Funding: pre-seed to Series C (not bootstrapped micro-businesses or Series D+ mega-rounds)

Available sources: explorium, wellfound, linkedin, indeed, crunchbase, apollo, glassdoor, surelyremote

Hiring status — set hiringInStack per company:
- Job board sources (wellfound, linkedin, indeed, glassdoor, surelyremote): companies returned ARE actively hiring → hiringInStack: true
- Database sources (explorium, crunchbase, apollo): hiring status is unknown → hiringInStack: false (enrichment will verify later)
- If a result includes job titles/open roles that match the target tech stack keywords: hiringInStack: true regardless of source

Decision rules:
1. Always start with the source specified in the task. If it returns < 5 results, automatically try 2–3 other sources with the same or adapted keywords.
2. If a source returns an error or is unavailable, skip it and try the next best source.
3. Good fallback order: explorium → wellfound → linkedin → indeed → glassdoor → crunchbase → apollo → surelyremote
4. explorium uses API-based company search — very reliable, no browser needed. Prefer it when available.
5. Adapt keywords when expanding — e.g. if "startup backend engineer" returns little, try "growth stage tech company software engineer" or "series b saas engineer".
6. Stop when you have ≥ 15 valid companies OR have tried all available sources.
7. Never return large enterprises (banks, consulting firms, FAANG, >200 employees) — the blocklist handles most, but use your judgment.
8. A 5–7 year old company with strong engineering hiring is a better lead than a 1-year-old startup with zero team.
9. Save ALL valid companies — even if not currently hiring in the target stack. These go on a watchlist and will be refreshed automatically.

After collecting results, call save_companies with all discovered companies (set hiringInStack accurately per company) and signal_done.`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'check_source_availability',
    description: 'Check if a scraper source has valid credentials and is available to use.',
    parameters: {
      type: 'object',
      properties: {
        source: { type: 'string', enum: Object.keys(SCRAPERS) },
      },
      required: ['source'],
    },
  },
  {
    name: 'scrape_source',
    description: 'Scrape a source for companies matching the query. Returns companies found.',
    parameters: {
      type: 'object',
      properties: {
        source:   { type: 'string', enum: Object.keys(SCRAPERS) },
        keywords: { type: 'string', description: 'Search keywords' },
        location: { type: 'string', default: 'United States' },
        limit:    { type: 'number', default: 25, description: 'Max results to fetch' },
      },
      required: ['source', 'keywords'],
    },
  },
  {
    name: 'save_companies',
    description: 'Save all valid discovered companies to the database. Companies actively hiring in the target stack are queued for enrichment; others go on a watchlist for later refresh. Call once when done collecting.',
    parameters: {
      type: 'object',
      properties: {
        companies: {
          type: 'array',
          description: 'Array of company objects to save',
          items: {
            type: 'object',
            properties: {
              name:           { type: 'string' },
              domain:         { type: 'string' },
              linkedinUrl:    { type: 'string' },
              employeeCount:  { type: 'number' },
              fundingStage:   { type: 'string' },
              techStack:      { type: 'array', items: { type: 'string' } },
              hqCountry:      { type: 'string' },
              source:         { type: 'string' },
              hiringInStack:  { type: 'boolean', description: 'True if company is confirmed to be actively hiring in the target tech stack. False if unknown (database source) or not hiring.' },
            },
            required: ['name', 'domain'],
          },
        },
      },
      required: ['companies'],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function makeHandlers(job: DiscoveryJobData): Record<string, ToolHandler> {
  return {
    check_source_availability: async ({ source }) => {
      const scraper = SCRAPERS[source as string];
      if (!scraper) return { available: false, reason: 'Unknown source' };
      const available = await scraper.isAvailable();
      return { available, source };
    },

    scrape_source: async ({ source, keywords, location = 'United States', limit = 25 }) => {
      const scraper = SCRAPERS[source as string];
      if (!scraper) return { error: `Unknown source: ${source}`, companies: [] };

      const available = await scraper.isAvailable();
      if (!available) return { error: `${source} is unavailable — missing credentials`, companies: [] };

      try {
        const rawResults = await scraper.scrape({
          keywords: keywords as string,
          location: location as string,
          limit: Number(limit),
        });

        const { companies } = normalizer.processResults(rawResults);
        const deduped = deduplicateCompanies(companies);

        // Apply filters — keep loose: enrich phase handles disqualification
        // Don't filter by missing tech stack — enrichment will fill it in
        const filtered = deduped.filter(c => {
          if (!c.domain || !c.name) return false;
          if (BLOCKED_DOMAINS.has(c.domain)) return false;
          if (c.name && BLOCKED_NAME_PATTERNS.some(re => re.test(c.name!))) return false;
          if (c.employeeCount && c.employeeCount > 1000) return false;
          return true;
        });

        logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery.agent] Scraped');
        // Return slim objects — LLM only needs name/domain/employees/stack to reason.
        // Full data (linkedinUrl, hqCountry etc.) is passed through save_companies.
        return {
          source,
          rawCount:      rawResults.length,
          filteredCount: filtered.length,
          companies: filtered.map(c => ({
            name:          c.name,
            domain:        c.domain,
            employeeCount: c.employeeCount,
            fundingStage:  c.fundingStage,
            techStack:     (c.techStack ?? []).slice(0, 4), // cap tags sent to LLM
            source,
          })),
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn({ source, err }, '[discovery.agent] Scrape failed');
        return { error: msg, companies: [] };
      }
    },

    save_companies: async ({ companies }) => {
      const list = companies as Array<Record<string, unknown>>;
      let saved = 0;
      let watchlisted = 0;
      let skipped = 0;

      for (const co of list) {
        const domain = normalizeDomain(String(co.domain ?? ''));
        if (!domain || !co.name) { skipped++; continue; }

        // hiringInStack: true  → discovered + enqueue for enrichment
        // hiringInStack: false → watchlist (no enrichment until refreshed)
        const hiringInStack = co.hiringInStack !== false; // default true if omitted
        const pipelineStatus = hiringInStack ? 'discovered' : 'watchlist';

        try {
          const company = await companyRepository.upsert({
            name:           String(co.name),
            domain,
            linkedinUrl:    co.linkedinUrl as string | undefined,
            employeeCount:  co.employeeCount as number | undefined,
            fundingStage:   co.fundingStage as string | undefined,
            techStack:      co.techStack as string[] | undefined,
            hqCountry:      (co.hqCountry as string | undefined) ?? 'US',
            sources:        [co.source as string ?? job.source],
            pipelineStatus,
          } as any);

          if (hiringInStack) {
            // Fire-and-forget Hunter contact pre-population
            if (process.env['HUNTER_API_KEY']) {
              hunterScraper.enrichDomain(domain).then(async result => {
                if (!result?.contacts?.length) return;
                for (const c of result.contacts) {
                  if (!c.fullName || !c.role) continue;
                  const role = normalizeRole(c.role as string);
                  if (role === 'Unknown') continue;
                  await contactRepository.upsert({
                    companyId:       company._id!,
                    fullName:        c.fullName,
                    firstName:       c.firstName,
                    lastName:        c.lastName,
                    role,
                    email:           c.email,
                    emailConfidence: c.emailConfidence ?? 0,
                    linkedinUrl:     c.linkedinUrl,
                    sources:         ['hunter'],
                    forOriginRatio:  false,
                  }).catch(() => {});
                }
              }).catch(() => {});
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
      return { saved, watchlisted, skipped, total: list.length };
    },
  };
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

  const config: AgentConfig = {
    name: `discovery:${source}:${runId.slice(0, 8)}`,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    handlers: makeHandlers(job),
    maxIterations: 12,
  };

  const userMessage = `
Find tech companies for B2B lead generation.

Primary source: ${source}
Keywords: ${query.keywords}
Location: ${query.location ?? 'United States'}
Target limit: ${query.limit ?? 25} companies

Start with ${source}. If you get fewer than 5 results or it fails, expand to other sources using similar keywords.
Prefer companies in: SaaS, AI/ML, BioTech,  Fintech, HealthTech, DevTools.
Target size: 10–200 employees. Age: founded 2018–present (up to ~7 years old). Funding: pre-seed to Series C.
A company founded 5–6 years ago that's actively hiring engineers is a perfect lead — do not skip it just because it's not "early stage".
`.trim();

  try {
    const result = await runAgent(config, userMessage);
    const saveCall = result.toolCallLog.find(t => t.tool === 'save_companies');
    const saved    = (saveCall?.result as any)?.saved ?? 0;

    await scrapeLogRepository.complete(logId, {
      status: 'success',
      companiesFound: saved,
      contactsFound: 0,
      jobsFound: 0,
      errors: [],
      durationMs: Date.now() - startedAt,
    });

    logger.info({ runId, source, saved, iterations: result.iterations }, '[discovery.agent] Complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound: 0, contactsFound: 0, jobsFound: 0,
      errors: [msg], durationMs: Date.now() - startedAt,
    }).catch(() => {});
    logger.error({ err, runId, source }, '[discovery.agent] Failed');
    throw err;
  }
}
