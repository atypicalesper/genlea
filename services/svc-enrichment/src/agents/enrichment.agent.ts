import { createAgent }                          from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import {
  buildLlm, alertAgentFailure, resilientAgentInvoke,
  companyRepository, scrapeLogRepository, queueManager, logger,
} from '@genlea/shared';
import type { EnrichmentJobData, AgentStep } from '@genlea/shared';
import { makeTools } from './enrichment-tools.js';

const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency that sells offshore Indian developer talent to US/UK/CA/EU tech startups.

GOAL: For each company, collect the following before calling queue_for_scoring:
  ✓ Tech stack (≥2 tags)
  ✓ ≥N developer names for Indian-origin ratio analysis (N = originRatioMinSample from settings)
  ✓ ≥1 decision-maker contact (CEO, CTO, VP Engineering, Head of Engineering, HR, or Recruiter)

WORKFLOW — follow this loop, don't follow a fixed sequence:
1. Call get_company_state to understand the starting point.
2. Call check_enrichment_progress — it tells you exactly what's missing and the nextBestAction.
3. Execute the nextBestAction.
4. Repeat from step 2 until goalMet: true.
5. Call compute_origin_ratio (if not done), then queue_for_scoring.

STOP IMMEDIATELY and call disqualify_company if:
- playwright_scrape_url returns defunct: true (unreachable domain, parked page, shutdown language)
- employeeCount > 1000
- hqCountry is India or non-target market
- No tech signal after trying ≥3 sources

AVAILABILITY RULE:
If any tool returns { available: false }, skip it immediately — do NOT retry it.
Fall back to playwright_scrape_url on /team /about /careers /contact pages.

KEY FACTS:
- playwright_scrape_url auto-saves people it finds — no separate save_contacts call needed for them.
- Each API source (enrich_github, enrich_explorium, enrich_clay, enrich_clearbit, enrich_hunter, scrape_website_team, verify_contacts, compute_origin_ratio) can only be called once per company.
- check_enrichment_progress can be called as many times as needed — call it after every action.
- Always save partial data: partial data is better than nothing. Call save_company_data with any metadata found.

SOURCE ORDER (skip if available: false):
1. enrich_github — free, always try first (tech stack + contributor names)
2. enrich_explorium — best for contacts (requires EXPLORIUM_API_KEY)
3. enrich_clay — good for contacts (requires CLAY_API_KEY)
4. scrape_website_team — free, finds team names
5. playwright_scrape_url — use aggressively on /team /about /careers /people /contact
6. enrich_clearbit — company metadata (requires CLEARBIT_API_KEY; skip if Explorium/Clay gave metadata)
7. enrich_hunter — email discovery (requires HUNTER_API_KEY)
8. verify_contacts — SMTP verify emails`;

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export async function runEnrichmentAgent(job: EnrichmentJobData): Promise<void> {
  const { runId, companyId, domain, force } = job;
  const startedAt = Date.now();

  const company = await companyRepository.findById(companyId);
  if (!company) {
    logger.warn({ companyId, domain }, '[enrichment.agent] Company not found — skipping');
    return;
  }

  if (company.employeeCount && company.employeeCount > 1000) {
    await companyRepository.disqualify(companyId);
    return;
  }

  await companyRepository.setPipelineStatus(companyId, 'enriching');

  if (!force && company.lastEnrichedAt) {
    const ageMs = Date.now() - new Date(company.lastEnrichedAt).getTime();
    if (ageMs < COOLDOWN_MS) {
      logger.info({ domain, ageHours: (ageMs / 3_600_000).toFixed(1) }, '[enrichment.agent] Cooldown — queuing scoring only');
      await queueManager.addScoringJob({ runId, companyId });
      return;
    }
  }

  const logId = (await scrapeLogRepository.create({
    runId, scraper: 'agent', status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt: new Date(),
  }))._id!;

  const userMessage = `
Enrich this company for lead scoring:

Company ID : ${companyId}
Domain     : ${domain}
Name       : ${company.name}
Known data : employees=${company.employeeCount ?? 'unknown'}, tech=${JSON.stringify(company.techStack ?? [])}, status=${company.status}

Start with get_company_state, then follow the goal loop (check_enrichment_progress → act → repeat).
Disqualify immediately if the domain is defunct or company is too large.
`.trim();

  const agentName     = `enrichment:${domain}`;
  const agentTools    = makeTools(job);
  const maxIterations = 20;

  try {
    const llm   = await buildLlm();
    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: SYSTEM_PROMPT });
    logger.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await resilientAgentInvoke(
      agent.invoke.bind(agent),
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
      { agentName, timeoutMs: 12 * 60 * 1000 },  // enrichment gets 12 min — more tools, more steps
    ) as Awaited<ReturnType<typeof agent.invoke>>;

    let iterations    = 0;
    let contactsFound = 0;
    let namesFound    = 0;
    const errors: string[]        = [];
    const agentSteps: AgentStep[] = [];
    const toolCallTimes = new Map<string, string>();

    for (const msg of agentResult.messages as (AIMessage | ToolMessage)[]) {
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        iterations++;
        const ts = new Date().toISOString();
        for (const call of msg.tool_calls) {
          if (call.id) toolCallTimes.set(call.id, ts);
          logger.debug({ agent: agentName, iter: iterations, tool: call.name, args: call.args }, '[agent] Tool call');
        }
      }
      if (msg instanceof ToolMessage && msg.name) {
        const ts = (msg.tool_call_id && toolCallTimes.get(msg.tool_call_id)) ?? new Date().toISOString();
        let parsed: unknown = msg.content;
        try { parsed = JSON.parse(msg.content as string); } catch { /* leave as string */ }
        const p = parsed as Record<string, unknown>;

        if (msg.name === 'check_enrichment_progress') {
          if (typeof p?.['decisionMakerCount'] === 'number') contactsFound = p['decisionMakerCount'] as number;
          if (typeof p?.['nameCount'] === 'number')          namesFound    = p['nameCount'] as number;
        }

        const latencyMs = typeof p?.['_latencyMs'] === 'number' ? p['_latencyMs'] as number : undefined;
        const summary   = buildStepSummary(msg.name, p);
        agentSteps.push({ tool: msg.name, summary, ts, latencyMs });

        if (p?.['error'] && !p?.['alreadyCalled'] && !p?.['alreadyScraped']) {
          errors.push(String(p['error']));
          logger.warn({ agent: agentName, tool: msg.name, error: p['error'] }, '[agent] Tool returned error');
        } else if (p?.['available'] === false) {
          logger.info({ agent: agentName, tool: msg.name, reason: p['reason'] }, '[agent] Tool unavailable');
        } else {
          logger.debug({ agent: agentName, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) }, '[agent] Tool result');
        }
      }
    }

    if (iterations >= maxIterations) {
      logger.warn({ agent: agentName, iterations, maxIterations }, '[agent] Hit max iterations');
    }

    // Fallback: if the agent finished without calling queue_for_scoring (e.g. hit maxIterations),
    // the company is stuck at 'enriching'. Queue best-effort scoring so it doesn't stay frozen.
    // Exclude disqualified companies — the disqualify_company tool sets status but not pipelineStatus.
    const afterState = await companyRepository.findById(companyId);
    if (afterState?.pipelineStatus === 'enriching' && afterState?.status !== 'disqualified') {
      logger.info({ domain }, '[enrichment.agent] Agent ended without scoring — queuing best-effort');
      await companyRepository.setPipelineStatus(companyId, 'scoring', new Date());
      await queueManager.addScoringJob({ runId, companyId });
    }

    const status = errors.length > 0 ? (contactsFound > 0 ? 'partial' : 'failed') : 'success';
    await scrapeLogRepository.complete(logId, {
      status,
      companiesFound: 1,
      contactsFound,
      jobsFound: 0,
      errors,
      durationMs: Date.now() - startedAt,
      agentSteps,
    });

    logger.info({
      domain, iterations, contactsFound, namesFound,
      durationMs: Date.now() - startedAt,
    }, '[enrichment.agent] Complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Reset pipeline status so the company can be re-enriched on the next run
    // rather than being stuck at 'enriching' forever.
    await companyRepository.setPipelineStatus(companyId, 'discovered').catch(() => {});
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound: 0, contactsFound: 0, jobsFound: 0,
      errors: [msg], durationMs: Date.now() - startedAt,
    }).catch(() => {});
    logger.error({ err, domain }, '[enrichment.agent] Failed');
    await alertAgentFailure({ agent: `enrichment:${domain}`, runId, error: err });
    throw err;
  }
}

function buildStepSummary(tool: string, p: Record<string, unknown>): string {
  if (p?.['error'])               return `error: ${String(p['error']).slice(0, 120)}`;
  if (p?.['available'] === false) return `unavailable: ${String(p['reason'] ?? 'no credential')}`;
  if (p?.['alreadyCalled'])       return 'skipped — already called this run';
  if (p?.['alreadyScraped'])      return 'skipped — already scraped this run';

  switch (tool) {
    case 'get_company_state':
      return `company: ${p['name'] ?? '?'} — employees: ${p['employeeCount'] ?? '?'}, tech: ${JSON.stringify(p['techStack'] ?? [])}`;
    case 'check_enrichment_progress': {
      const goal = p['goalMet'] ? 'DONE' : `missing: ${JSON.stringify(p['missing'] ?? [])}`;
      return `progress — contacts: ${p['decisionMakerCount'] ?? 0}, names: ${p['nameCount'] ?? 0}, ${goal}`;
    }
    case 'enrich_github':
      return `github: ${p['contributors'] ?? 0} contributors, tech: ${JSON.stringify(p['techStack'] ?? [])}`;
    case 'enrich_hunter':
      return `hunter: ${p['contacts'] ?? 0} contacts found`;
    case 'enrich_clearbit':
      return `clearbit: employees=${p['employeeCount'] ?? '?'}, location=${p['hqCountry'] ?? '?'}`;
    case 'enrich_explorium':
    case 'enrich_clay':
      return `${tool}: ${p['contacts'] ?? 0} contacts`;
    case 'scrape_website_team':
      return `website-team: ${p['names'] ?? 0} names found`;
    case 'playwright_scrape_url':
      return `playwright: ${p['contacts'] ?? 0} contacts, ${p['names'] ?? 0} names — url: ${p['url'] ?? '?'}`;
    case 'compute_origin_ratio':
      return `origin ratio: ${p['ratio'] ?? '?'} (${p['indianCount'] ?? 0}/${p['totalCount'] ?? 0} names)`;
    case 'queue_for_scoring':
      return `queued for scoring`;
    case 'disqualify_company':
      return `disqualified: ${String(p['reason'] ?? '?')}`;
    default:
      return JSON.stringify(p).slice(0, 100);
  }
}
