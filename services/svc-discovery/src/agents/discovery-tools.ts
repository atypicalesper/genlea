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
  logger,
} from '@genlea/shared';
import type { DiscoveryJobData } from '@genlea/shared';
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
3. After each scrape, call save_companies with the filtered results.
4. Call get_discovery_state again — if goalMet: true, stop immediately.
5. If not met and < 5 results were found from primary, try 1–2 fallback sources.
6. Never try the same source twice (get_discovery_state.sourcesTried shows what's been done).

Target company profile:
- Size: 10–200 employees
- Age: founded within the last 7 years (2018–present)
- Hiring: actively posting software engineering roles
- Verticals: SaaS, AI/ML, Fintech, HealthTech, DevTools, B2B Software, EdTech, LegalTech, Cybersecurity, MarTech, HRTech, CleanTech, E-commerce Tech, Data & Analytics
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
  let totalSaved = 0;

  return [

    // ── 0. Discovery state — goal check ───────────────────────────────────────
    tool(
      async () => {
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
      },
      {
        name:        'get_discovery_state',
        description: 'Check current discovery progress: how many companies have been saved, which sources have been tried, and whether the goal is met. Call this first and after each save.',
        schema: z.object({}),
      },
    ),

    // ── 1. Source availability check ──────────────────────────────────────────
    tool(
      async ({ source }) => {
        const scraper = SCRAPERS[source];
        if (!scraper) return JSON.stringify({ available: false, reason: 'Unknown source' });
        const available = await scraper.isAvailable();
        return JSON.stringify({ available, source });
      },
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
      async ({ source, keywords, location = 'United States', limit = 25 }) => {
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

          logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery-tools] Scraped');

          return JSON.stringify({
            source,
            rawCount:      rawResults.length,
            filteredCount: filtered.length,
            companies: filtered.map(c => ({
              name:          c.name,
              domain:        c.domain,
              linkedinUrl:   c.linkedinUrl,
              employeeCount: c.employeeCount,
              fundingStage:  c.fundingStage,
              techStack:     (c.techStack ?? []).slice(0, 4),
              source,
            })),
          });
        } catch (err) {
          const msg   = err instanceof Error ? err.message : String(err);
          const cause = (err as any)?.cause ? String((err as any).cause) : undefined;
          const code  = (err as any)?.code;
          logger.warn({ source, keywords, error: msg, cause, code }, '[discovery-tools] Scrape failed');
          return JSON.stringify({ error: msg, cause, code, companies: [] });
        }
      },
      {
        name:        'scrape_source',
        description: 'Scrape a source for companies matching the query. Each source can only be tried once per run.',
        schema: z.object({
          source:   z.string().describe(`Source to scrape. Available: ${availableSources}`),
          keywords: z.string().describe('Search keywords'),
          location: z.string().default('United States'),
          limit:    z.number().int().min(1).max(100).default(25),
        }),
      },
    ),

    // ── 3. Save companies ─────────────────────────────────────────────────────
    tool(
      async ({ companies }) => {
        let saved = 0, watchlisted = 0, skipped = 0;

        for (const co of companies) {
          const domain = normalizeDomain(co.domain ?? '');
          if (!domain || !co.name) { skipped++; continue; }
          if (!(await resolvesRealDomain(domain))) { skipped++; continue; }

          const hiringInStack  = co.hiringInStack !== false;
          const pipelineStatus = hiringInStack ? 'discovered' : 'watchlist';

          try {
            const company = await companyRepository.upsert({
              name:          co.name,
              domain,
              linkedinUrl:   co.linkedinUrl,
              employeeCount: co.employeeCount,
              fundingStage:  co.fundingStage as any,
              techStack:     co.techStack,
              hqCountry:     co.hqCountry ?? 'US',
              sources:       [co.source ?? job.source] as any,
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
                sources:   ['github', 'hunter', 'clearbit'],
              });
              saved++;
            } else {
              watchlisted++;
            }
          } catch { skipped++; }
        }

        totalSaved += saved;
        logger.info({ saved, watchlisted, skipped, runningTotal: totalSaved }, '[discovery-tools] Companies saved');
        return JSON.stringify({ saved, watchlisted, skipped, total: companies.length, runningTotal: totalSaved });
      },
      {
        name:        'save_companies',
        description: 'Save all valid discovered companies to the database. Actively-hiring companies are queued for enrichment; others go on a watchlist. Returns runningTotal across all save_companies calls this run.',
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
            hiringInStack: z.boolean().optional().describe('True if company is confirmed actively hiring in the target tech stack'),
          })).describe('Array of company objects to save'),
        }),
      },
    ),
  ];
}
