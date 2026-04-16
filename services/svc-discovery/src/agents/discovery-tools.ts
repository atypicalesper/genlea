import { z } from 'zod';
import { tool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  normalizer,
  normalizeRole,
  deduplicateCompanies,
  companyRepository,
  contactRepository,
  queueManager,
  normalizeDomain,
  getAvailableSources,
  sanitizeAgentInput,
  isInjectionAttempt,
  withTiming,
  logger,
} from '@genlea/shared';
import type { DiscoveryJobData, Company } from '@genlea/shared';
import { SCRAPERS, BLOCKED_DOMAINS, BLOCKED_NAME_PATTERNS, isJunkDomain } from '../discovery/blocklists.js';
import { resolvesRealDomain } from '../discovery/domain-validator.js';
import { hunterScraper } from '../scrapers/index.js';

export function buildSystemPrompt(): string {
  const available  = getAvailableSources();
  const activeList = Object.keys(SCRAPERS).filter(s => available.has(s as any)).join(', ');
  const skipList   = Object.keys(SCRAPERS).filter(s => !available.has(s as any));

  const skipNote = skipList.length
    ? `\nUnavailable sources (no credentials — do NOT call these): ${skipList.join(', ')}`
    : '';

  return `You are a B2B lead generation discovery agent for a software agency that sells offshore Indian developer talent to US/UK/CA/AU/EU tech companies.

GOAL: Find and save ≥15 valid tech companies matching the query. Stop as soon as the goal is met.

WORKFLOW:
1. Call get_discovery_state — check if goal is already met before scraping anything.
2. If not met, call scrape_source for the primary source.
3. After each scrape_source call, immediately call save_companies with source="<same source name>". Do NOT pass company data — just the source name.
4. Call get_discovery_state again — if goalMet: true, stop.
5. If not met and < 5 results were found from primary, try 1–2 fallback sources.
6. Never try the same source twice (get_discovery_state.sourcesTried shows what's been done).

Target company profile:
- Size: 10–200 employees
- Hiring: actively posting software engineering roles
- Verticals: SaaS, AI/ML, Fintech, HealthTech, DevTools, B2B Software, EdTech, LegalTech, Cybersecurity, MarTech, HRTech, CleanTech, E-commerce Tech, Data & Analytics, PropTech, InsurTech, LogisticsTech, SupplyChainTech, AdTech, IoT, AR/VR, GovTech, RetailTech, TravelTech, FoodTech, ConstructionTech, AutoTech, DeepTech, Web3, AgriTech
- Funding: pre-seed to Series C

Available sources: ${activeList}${skipNote}

Hiring status — set hiringInStack per company:
- Job board sources (wellfound, linkedin, indeed, glassdoor, surelyremote): companies returned ARE hiring → hiringInStack: true
- Database sources (explorium, crunchbase, apollo): hiring unknown → hiringInStack: false

Fallback order (if primary fails or returns < 5): explorium → wellfound → indeed → glassdoor → crunchbase → apollo → surelyremote

Do NOT save large enterprises (banks, consulting firms, FAANG, >500 employees).`;
}

export function makeTools(job: DiscoveryJobData): StructuredToolInterface[] {
  const availableSources = [...getAvailableSources()].filter(s => s in SCRAPERS).join(', ');

  // ── Per-job closure state ────────────────────────────────────────────────────
  const triedSources = new Set<string>();
  // Stores filtered companies after each scrape_source call.
  // save_companies reads from here by source — the LLM never echoes company data back.
  const pendingBySource = new Map<string, Partial<Company & { hiringInStack?: boolean; source?: string }>[]>();
  let totalSaved = 0;

  return [

    // ── 0. Discovery state — goal check ───────────────────────────────────────
    tool(
      withTiming('get_discovery_state', async () => {
        const available  = [...getAvailableSources()].filter(s => s in SCRAPERS);
        const remaining  = available.filter(s => !triedSources.has(s));
        const goalMet    = totalSaved >= 15;
        return JSON.stringify({
          companiesFound:   totalSaved,
          goalMet,
          goalTarget:       15,
          sourcesTried:     [...triedSources],
          remainingSources: remaining,
          nextRecommendedSource: remaining[0] ?? null,
          message: goalMet
            ? `Goal met (${totalSaved} companies saved) — call save_companies with any remaining results then stop.`
            : `Need ${Math.max(0, 15 - totalSaved)} more companies. Try: ${remaining.slice(0, 3).join(', ')}.`,
        });
      }),
      {
        name:        'get_discovery_state',
        description: 'Check current discovery progress: how many companies have been saved, which sources have been tried, and whether the goal is met. Call this first and after each save.',
        schema: z.object({}),
      },
    ),

    // ── 1. Source availability check ──────────────────────────────────────────
    tool(
      withTiming('check_source_availability', async ({ source }) => {
        const scraper = SCRAPERS[source];
        if (!scraper) return JSON.stringify({ available: false, reason: 'Unknown source' });
        const available = await scraper.isAvailable();
        return JSON.stringify({ available, source });
      }),
      {
        name:        'check_source_availability',
        description: 'Check if a scraper source has valid credentials and is ready to use.',
        schema: z.object({
          source: z.string().describe(`Source to check. Available: ${availableSources}`),
        }),
      },
    ),

    // ── 2. Scrape source ──────────────────────────────────────────────────────
    tool(
      withTiming('scrape_source', async ({ source, keywords: rawKeywords, location, limit = 25 }) => {
        const keywords = sanitizeAgentInput(rawKeywords, 300);
        if (isInjectionAttempt(rawKeywords)) {
          logger.warn({ source, rawKeywords }, '[discovery-tools] Injection attempt in keywords — sanitized');
        }
        // Dedup: prevent re-scraping the same source
        if (triedSources.has(source)) {
          return JSON.stringify({
            error: `${source} already tried in this run — use get_discovery_state to see remaining sources`,
            alreadyTried: true,
            companies: [],
          });
        }
        triedSources.add(source);

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
            if (isJunkDomain(c.domain)) return false;
            if (c.name && BLOCKED_NAME_PATTERNS.some(re => re.test(c.name!))) return false;
            if (c.employeeCount && c.employeeCount > 1000) return false;
            return true;
          });

          // Store in closure so save_companies can pick them up without re-passing through the LLM
          pendingBySource.set(source, filtered.map(c => ({ ...c, source })));

          logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery-tools] Scraped');

          // Return only a summary — company data lives in pendingBySource, not in the LLM context.
          // This prevents the LLM from echoing back thousands of tokens in the save_companies call.
          return JSON.stringify({
            source,
            rawCount:      rawResults.length,
            filteredCount: filtered.length,
            preview: filtered.slice(0, 3).map(c => ({ name: c.name, domain: c.domain, employees: c.employeeCount })),
            message: `${filtered.length} companies ready to save. Call save_companies with source="${source}" to persist them.`,
          });
        } catch (err) {
          const msg   = err instanceof Error ? err.message : String(err);
          const cause = (err as any)?.cause ? String((err as any).cause) : undefined;
          const code  = (err as any)?.code;
          logger.warn({ source, keywords, error: msg, cause, code }, '[discovery-tools] Scrape failed');
          return JSON.stringify({ error: msg, cause, code, companies: [] });
        }
      }),
      {
        name:        'scrape_source',
        description: 'Scrape a source for companies matching the query. Each source can only be tried once per run.',
        schema: z.object({
          source:   z.string().refine(s => s in SCRAPERS, {
            message: `Unknown source. Valid sources: ${availableSources}`,
          }).describe(`Source to scrape. Must be one of: ${availableSources}`),
          keywords: z.string().min(1).max(300).describe('Search keywords — plain text only, max 300 chars'),
          location: z.string().max(100).optional(),
          limit:    z.number().int().min(1).max(100).default(25),
        }),
      },
    ),

    // ── 3. Save companies ─────────────────────────────────────────────────────
    tool(
      withTiming('save_companies', async ({ source, hiringInStack: defaultHiring = true }) => {
        const companies = pendingBySource.get(source);
        if (!companies?.length) {
          return JSON.stringify({ error: `No pending results for source "${source}". Call scrape_source first.`, saved: 0, runningTotal: totalSaved });
        }
        // Consume the pending batch
        pendingBySource.delete(source);

        let saved = 0, watchlisted = 0, skipped = 0;

        for (const co of companies) {
          const domain = normalizeDomain((co as any).domain ?? '');
          if (!domain || !(co as any).name) { skipped++; continue; }
          if (!(await resolvesRealDomain(domain))) { skipped++; continue; }

          // Job-board sources (wellfound, linkedin, indeed, glassdoor, surelyremote) are always hiring
          const isJobBoard = ['wellfound', 'linkedin', 'indeed', 'glassdoor', 'surelyremote'].includes(source);
          const hiringInStack = isJobBoard || defaultHiring;
          const pipelineStatus = hiringInStack ? 'discovered' : 'watchlist';

          try {
            const company = await companyRepository.upsert({
              name:          (co as any).name,
              domain,
              linkedinUrl:   (co as any).linkedinUrl,
              employeeCount: (co as any).employeeCount,
              fundingStage:  (co as any).fundingStage as any,
              techStack:     (co as any).techStack,
              hqCountry:     (co as any).hqCountry ?? 'US',
              sources:       [source ?? job.source] as any,
              pipelineStatus,
            } as any);

            if (hiringInStack) {
              // Pre-populate contacts from Hunter (non-blocking, best-effort)
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
                      }).catch(err => logger.debug({ err, domain }, '[discovery-tools] Hunter pre-pop failed')),
                    ),
                  );
                }).catch(err => logger.debug({ err, domain }, '[discovery-tools] Hunter pre-pop error'));
              }

              await queueManager.addEnrichmentJob({
                runId:     job.runId,
                companyId: company._id!,
                domain:    company.domain,
              });
              saved++;
            } else {
              watchlisted++;
            }
          } catch { skipped++; }
        }

        totalSaved += saved;
        logger.info({ source, saved, watchlisted, skipped, runningTotal: totalSaved }, '[discovery-tools] Companies saved');
        return JSON.stringify({ saved, watchlisted, skipped, total: companies.length, runningTotal: totalSaved });
      }),
      {
        name:        'save_companies',
        description: 'Persist companies from a completed scrape_source call. Pass the source name — company data is stored internally after scrape_source runs. Actively-hiring companies are queued for enrichment.',
        schema: z.object({
          source:        z.string().describe('The source name you just scraped (e.g. "wellfound", "indeed")'),
          hiringInStack: z.boolean().optional().describe('Whether these companies are actively hiring (default: true for job-board sources)'),
        }),
      },
    ),
  ];
}
