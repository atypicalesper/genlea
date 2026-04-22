import { z }                          from 'zod';
import { tool }                        from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { normalizer, normalizeRole }   from '../enrichment/normalizer.js';
import { deduplicateCompanies }        from '../enrichment/deduplicator.js';
import { companyRepository }           from '../storage/repositories/company.repository.js';
import { contactRepository }           from '../storage/repositories/contact.repository.js';
import { queueManager }                from '../core/queue.manager.js';
import { normalizeDomain }             from '../utils/random.js';
import { hunterScraper }               from '../scrapers/enrichment/index.js';
import { logger }                      from '../utils/logger.js';
import { getAvailableSources }         from '../core/scheduler.js';
import { SCRAPERS, BLOCKED_DOMAINS, BLOCKED_NAME_PATTERNS, isJunkDomain } from '../discovery/blocklists.js';
import { resolvesRealDomain }          from '../discovery/domain-validator.js';
import { resolveDomainFromHintUrls, resolveNameToDomain } from '../discovery/domain-resolver.js';
import type { DiscoveryJobData, RawResult } from '../types/index.js';

const slugifyName = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'unknown';

type PendingDiscoveryCompany = Record<string, unknown> & {
  _candidateUrls?: string[];
};

export function buildSystemPrompt(): string {
  const available  = getAvailableSources();
  const activeList = Object.keys(SCRAPERS).filter(s => available.has(s as any)).join(', ');
  const skipList   = Object.keys(SCRAPERS).filter(s => !available.has(s as any));

  const skipNote = skipList.length
    ? `\nUnavailable sources (no credentials — do NOT call these): ${skipList.join(', ')}`
    : '';

  return `You are a B2B lead discovery agent for a software agency.

Goal:
- save at least 15 companies
- exclude India-headquartered companies
- exclude big enterprises and companies above 1000 employees
- prefer companies hiring engineering roles
- prefer companies likely to already employ Indian-origin engineers

Workflow:
1. Call get_discovery_state.
2. Scrape the primary source.
3. Immediately call save_companies for that source.
4. Re-check get_discovery_state.
5. If needed, try 1-2 fallback sources.
6. Never try the same source twice.

Available sources: ${activeList}${skipNote}

Hiring signal:
- job boards / ATS sources imply active hiring
- database sources need later enrichment

Source preference:
greenhouse → lever → ashby → workable → explorium → wellfound → indeed → glassdoor → crunchbase → apollo → surelyremote

Never save:
- big enterprises, FAANG, banks, consulting giants, or companies above 1000 employees
- India-headquartered companies
- staffing agencies, outsourcing vendors, and job boards
- companies with no engineering hiring signal`;
}

export function makeTools(job: DiscoveryJobData): StructuredToolInterface[] {
  const availableSources = [...getAvailableSources()].filter(s => s in SCRAPERS).join(', ');

  const triedSources    = new Set<string>();
  const pendingBySource = new Map<string, PendingDiscoveryCompany[]>();
  let totalSaved = 0;

  return [

    // ── 0. Discovery state ──────────────────────────────────────────────────────
    tool(
      async () => {
        const available  = [...getAvailableSources()].filter(s => s in SCRAPERS);
        const remaining  = available.filter(s => !triedSources.has(s));
        const goalMet    = totalSaved >= 15;
        return JSON.stringify({
          companiesFound:        totalSaved,
          goalMet,
          goalTarget:            15,
          sourcesTried:          [...triedSources],
          remainingSources:      remaining,
          nextRecommendedSource: remaining[0] ?? null,
          message: goalMet
            ? `Goal met (${totalSaved} companies saved) — stop.`
            : `Need ${Math.max(0, 15 - totalSaved)} more companies. Try: ${remaining.slice(0, 3).join(', ')}.`,
        });
      },
      {
        name:        'get_discovery_state',
        description: 'Check progress and whether the 15-company goal is met. Call first and after each save.',
        schema: z.object({}),
      },
    ),

    // ── 1. Scrape source ────────────────────────────────────────────────────────
    tool(
      async ({ source, keywords, location = 'United States', limit = 25 }) => {
        if (triedSources.has(source)) {
          return JSON.stringify({
            error: `${source} already tried this run — use get_discovery_state to see remaining sources`,
            alreadyTried: true,
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
          const diagnostics = scraper.getLastDiagnostics?.();
          const { companies } = normalizer.processResults(rawResults);
          const deduped = deduplicateCompanies(companies);
          const identityHints = collectIdentityHints(rawResults);

          const filtered = deduped.filter(c => {
            if (!c.name) return false;
            if (c.domain && BLOCKED_DOMAINS.has(c.domain)) return false;
            if (c.domain && isJunkDomain(c.domain)) return false;
            if (BLOCKED_NAME_PATTERNS.some(re => re.test(c.name!))) return false;
            if (c.employeeCount && c.employeeCount > 1000) return false;
            return true;
          });

          pendingBySource.set(
            source,
            filtered.map(c => {
              const urls = identityHints.get(normalizeNameKey(c.name));
              return {
                ...c,
                source,
                _candidateUrls: urls,
              };
            }),
          );

          logger.info({ source, raw: rawResults.length, filtered: filtered.length }, '[discovery-tools] Scraped');

          return JSON.stringify({
            source,
            rawCount:      rawResults.length,
            filteredCount: filtered.length,
            preview:       filtered.slice(0, 3).map(c => ({ name: c.name, domain: c.domain, employees: c.employeeCount })),
            diagnostics,
            message:       `${filtered.length} companies ready. Call save_companies with source="${source}".`,
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
        description: 'Scrape one source. Each source can only be used once per run. Call save_companies right after.',
        schema: z.object({
          source:   z.string().describe(`Source to scrape. Must be one of: ${availableSources}`),
          keywords: z.string().min(1).max(300).describe('Search keywords — plain text only, max 300 chars'),
          location: z.string().max(100).optional(),
          limit:    z.number().int().min(1).max(100).default(25),
        }),
      },
    ),

    // ── 2. Save companies ───────────────────────────────────────────────────────
    tool(
      async ({ source, hiringInStack: defaultHiring = true }) => {
        if (!pendingBySource.has(source)) {
          return JSON.stringify({
            error:        `scrape_source("${source}") has not been called yet this run. Call it first.`,
            saved:        0,
            runningTotal: totalSaved,
          });
        }
        const companies = pendingBySource.get(source)!;
        if (!companies.length) {
          pendingBySource.delete(source);
          return JSON.stringify({ saved: 0, watchlisted: 0, skipped: 0, total: 0, runningTotal: totalSaved, message: `${source} scraped 0 results — try a different source.` });
        }
        pendingBySource.delete(source);

        let saved = 0, watchlisted = 0, skipped = 0, resolvedCount = 0, urlResolved = 0;

        for (const co of companies) {
          const name = co['name'] as string | undefined;
          if (!name) { skipped++; continue; }

          const resolved = await resolveDiscoveryDomain(name, co);
          let domain = resolved.domain;
          let domainResolved = true;
          if (!domain) {
            // Preserve unresolved companies so discovery can still surface them for manual review.
            domain = `${slugifyName(name)}.unresolved`;
            domainResolved = false;
          } else if (!(await resolvesRealDomain(domain))) {
            logger.debug({ domain }, '[discovery-tools] DNS unresolved — keeping anyway');
            // Keep the real hostname for visibility, but avoid auto-enrichment until it resolves cleanly.
            domainResolved = false;
          } else {
            resolvedCount++;
            if (resolved.method === 'hint_url') urlResolved++;
          }

          // Auto-enrichment only makes sense once we have a trustworthy domain to hand downstream.
          const isJobBoard    = ['wellfound', 'linkedin', 'indeed', 'glassdoor', 'surelyremote', 'greenhouse', 'lever', 'ashby', 'workable'].includes(source);
          const hiringInStack = isJobBoard || defaultHiring;
          const pipelineStatus = hiringInStack && domainResolved ? 'discovered' : 'watchlist';

          try {
            const company = await companyRepository.upsert({
              name,
              domain,
              linkedinUrl:   co['linkedinUrl']   as string   | undefined,
              employeeCount: co['employeeCount'] as number   | undefined,
              fundingStage:  co['fundingStage']  as any,
              techStack:     co['techStack']     as string[] | undefined,
              hqCountry:     (co['hqCountry'] as string | undefined) ?? 'US',
              sources:       [source ?? job.source] as any,
              pipelineStatus,
            } as any);

            if (hiringInStack && domainResolved) {
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
        logger.info({ source, saved, watchlisted, skipped, nameResolved: resolvedCount, urlResolved, runningTotal: totalSaved }, '[discovery-tools] Companies saved');
        return JSON.stringify({ saved, watchlisted, skipped, nameResolved: resolvedCount, urlResolved, total: companies.length, runningTotal: totalSaved });
      },
      {
        name:        'save_companies',
        description: 'Persist the pending results for a source and queue enrichable companies.',
        schema: z.object({
          source:        z.string().describe('The source name you just scraped (e.g. "wellfound", "indeed")'),
          hiringInStack: z.boolean().optional().describe('Whether these companies are actively hiring (default: true for job-board sources)'),
        }),
      },
    ),
  ];
}

async function resolveDiscoveryDomain(
  name: string,
  company: PendingDiscoveryCompany,
): Promise<{ domain: string; method: 'existing' | 'hint_url' | 'name_lookup' } | { domain: null; method: 'unresolved' }> {
  const existing = normalizeDomain(String(company['domain'] ?? ''));
  if (existing) return { domain: existing, method: 'existing' };

  const hintUrls = dedupeStrings([
    company['websiteUrl'],
    company['linkedinUrl'],
    ...(company._candidateUrls ?? []),
  ]);
  if (hintUrls.length) {
    const fromHints = await resolveDomainFromHintUrls(hintUrls);
    if (fromHints && !BLOCKED_DOMAINS.has(fromHints) && !isJunkDomain(fromHints)) {
      logger.debug({ name, domain: fromHints }, '[discovery-tools] Resolved domain from URL hints');
      return { domain: fromHints, method: 'hint_url' };
    }
  }

  const resolved = await resolveNameToDomain(name);
  if (resolved && !BLOCKED_DOMAINS.has(resolved) && !isJunkDomain(resolved)) {
    logger.debug({ name, domain: resolved }, '[discovery-tools] Resolved name→domain via Clearbit');
    return { domain: resolved, method: 'name_lookup' };
  }

  return { domain: null, method: 'unresolved' };
}

function collectIdentityHints(rawResults: RawResult[]): Map<string, string[]> {
  const hints = new Map<string, Set<string>>();
  for (const result of rawResults) {
    const key = normalizeNameKey(result.company?.name);
    if (!key) continue;
    const urls = [
      result.company?.websiteUrl,
      result.company?.linkedinUrl,
      result.company?.crunchbaseUrl,
      ...(result.company?.identityHintUrls ?? []),
      ...(result.jobs?.flatMap(job => [job.sourceUrl, job.applyUrl]) ?? []),
      ...(result.contacts?.flatMap(contact => [contact.linkedinUrl, contact.twitterUrl]) ?? []),
    ];
    for (const url of dedupeStrings(urls)) {
      if (!hints.has(key)) hints.set(key, new Set());
      hints.get(key)!.add(url);
    }
  }
  return new Map([...hints.entries()].map(([key, urls]) => [key, [...urls]]));
}

function dedupeStrings(values: unknown[]): string[] {
  return [...new Set(values.map(v => typeof v === 'string' ? v.trim() : '').filter(Boolean))];
}

function normalizeNameKey(name: unknown): string {
  return typeof name === 'string' ? name.trim().toLowerCase() : '';
}
