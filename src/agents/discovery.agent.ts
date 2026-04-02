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
import { normalizer } from '../enrichment/normalizer.js';
import { deduplicateCompanies } from '../enrichment/deduplicator.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { scrapeLogRepository } from '../storage/repositories/scrape-log.repository.js';
import { queueManager } from '../core/queue.manager.js';
import { normalizeDomain } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import {
  linkedInScraper, apolloScraper, crunchbaseScraper, wellfoundScraper,
  indeedScraper, glassdoorScraper, surelyRemoteScraper,
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
  wellfound:    wellfoundScraper,
  linkedin:     linkedInScraper,
  indeed:       indeedScraper,
  crunchbase:   crunchbaseScraper,
  apollo:       apolloScraper,
  glassdoor:    glassdoorScraper,
  surelyremote: surelyRemoteScraper,
};

const SYSTEM_PROMPT = `You are a B2B lead generation discovery agent for a software agency that sells offshore Indian developer talent to US/UK/CA/AU/EU tech startups.

Your goal: find early-stage tech startups (seed, series A, series B) with 10–200 employees that are hiring software engineers. These companies are pre-qualified leads because they are actively hiring and in a growth phase.

Available sources: wellfound, linkedin, indeed, crunchbase, apollo, glassdoor, surelyremote

Decision rules:
1. Always start with the source specified in the task. If it returns < 5 results, automatically try 2–3 other sources with the same or adapted keywords.
2. If a source returns an error or is unavailable, skip it and try the next best source.
3. Good fallback order: wellfound → linkedin → indeed → glassdoor → crunchbase → apollo → surelyremote
4. Adapt keywords when expanding — e.g. if "YC startup backend engineer" returns little, try "seed stage startup software engineer" or "early stage saas startup engineer".
5. Stop when you have ≥ 15 valid companies OR have tried all available sources.
6. Never return large enterprises (banks, consulting firms, FAANG, etc.) — the blocklist handles most, but use your judgment.
7. Prefer companies that match: SaaS, AI/ML, Fintech, HealthTech, DevTools — these are the best leads.

After collecting results, call save_companies with all discovered companies and signal_done.`;

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
    description: 'Save all valid discovered companies to the database and queue them for enrichment. Call once when done collecting.',
    parameters: {
      type: 'object',
      properties: {
        companies: {
          type: 'array',
          description: 'Array of company objects to save',
          items: {
            type: 'object',
            properties: {
              name:          { type: 'string' },
              domain:        { type: 'string' },
              linkedinUrl:   { type: 'string' },
              employeeCount: { type: 'number' },
              fundingStage:  { type: 'string' },
              techStack:     { type: 'array', items: { type: 'string' } },
              hqCountry:     { type: 'string' },
              source:        { type: 'string' },
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

        // Apply filters
        const filtered = deduped.filter(c => {
          if (!c.domain || !c.name) return false;
          if (BLOCKED_DOMAINS.has(c.domain)) return false;
          if (c.name && BLOCKED_NAME_PATTERNS.some(re => re.test(c.name!))) return false;
          if (c.employeeCount && c.employeeCount > 1000) return false;
          const hasTech = (c.techStack?.length ?? 0) > 0;
          const hasJob  = rawResults.some(r => r.company?.domain && normalizeDomain(r.company.domain) === c.domain && r.jobs?.some(j => j.techTags?.length));
          if (!hasTech && !hasJob) return false;
          return true;
        });

        logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery.agent] Scraped');
        return {
          source,
          rawCount: rawResults.length,
          filteredCount: filtered.length,
          companies: filtered.map(c => ({
            name:          c.name,
            domain:        c.domain,
            linkedinUrl:   c.linkedinUrl,
            employeeCount: c.employeeCount,
            fundingStage:  c.fundingStage,
            techStack:     c.techStack,
            hqCountry:     c.hqCountry,
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
      let skipped = 0;

      for (const co of list) {
        const domain = normalizeDomain(String(co.domain ?? ''));
        if (!domain || !co.name) { skipped++; continue; }

        try {
          const company = await companyRepository.upsert({
            name:          String(co.name),
            domain,
            linkedinUrl:   co.linkedinUrl as string | undefined,
            employeeCount: co.employeeCount as number | undefined,
            fundingStage:  co.fundingStage as string | undefined,
            techStack:     co.techStack as string[] | undefined,
            hqCountry:     (co.hqCountry as string | undefined) ?? 'US',
            sources:       [co.source as string ?? job.source],
          } as any);

          await queueManager.addEnrichmentJob({
            runId:     job.runId,
            companyId: company._id!,
            domain:    company.domain,
            sources:   ['github', 'hunter', 'clearbit'],
          });
          saved++;
        } catch { skipped++; }
      }

      logger.info({ saved, skipped }, '[discovery.agent] Companies saved');
      return { saved, skipped, total: list.length };
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
Find US tech startups for lead generation.

Primary source: ${source}
Keywords: ${query.keywords}
Location: ${query.location ?? 'United States'}
Target limit: ${query.limit ?? 25} companies

Start with ${source}. If you get fewer than 5 results or it fails, expand to other sources using similar keywords.
Prefer companies in: SaaS, AI/ML, Fintech, HealthTech, DevTools.
Target size: 10–200 employees, funding stage: pre-seed to Series B.
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
