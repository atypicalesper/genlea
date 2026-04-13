import { createAgent }                          from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import {
  buildLlm, alertAgentFailure,
  companyRepository, queueManager, logger,
} from '@genlea/shared';
import type { EnrichmentJobData } from '@genlea/shared';
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

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
    );

    let iterations = 0;
    let contactsFound = 0;
    let namesFound    = 0;
    const errors: string[] = [];

    for (const msg of agentResult.messages as (AIMessage | ToolMessage)[]) {
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        iterations++;
        for (const call of msg.tool_calls) {
          logger.debug({ agent: agentName, iter: iterations, tool: call.name, args: call.args }, '[agent] Tool call');
        }
      }
      if (msg instanceof ToolMessage && msg.name) {
        let parsed: unknown = msg.content;
        try { parsed = JSON.parse(msg.content as string); } catch { /* leave as string */ }
        const p = parsed as Record<string, unknown>;

        // Track enrichment outcomes
        if (msg.name === 'check_enrichment_progress') {
          if (typeof p?.['decisionMakerCount'] === 'number') contactsFound = p['decisionMakerCount'] as number;
          if (typeof p?.['nameCount'] === 'number')          namesFound    = p['nameCount'] as number;
        }

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

    logger.info({
      domain, iterations, contactsFound, namesFound,
      durationMs: Date.now() - startedAt,
    }, '[enrichment.agent] Complete');
  } catch (err) {
    logger.error({ err, domain }, '[enrichment.agent] Failed');
    await alertAgentFailure({ agent: `enrichment:${domain}`, runId, error: err });
    throw err;
  }
}
