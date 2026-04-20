/**
 * Enrichment Agent
 *
 * Given a company, the agent autonomously decides:
 *   - What data is already available (get_company_state)
 *   - Which enrichment sources to try and in what order
 *   - When to use Playwright stealth as a fallback (API fails / rate-limited)
 *   - Whether the company should be disqualified (defunct, too large, wrong country)
 *   - When enough data has been gathered to proceed to scoring
 *   - If data is insufficient, it tries ALL available sources before giving up
 *
 * Workers call runEnrichmentAgent() — no manual intervention needed.
 */

import { createAgent }           from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { buildLlm }              from './llm.client.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { companyRepository }     from '../storage/repositories/company.repository.js';
import { queueManager }          from '../core/queue.manager.js';
import { logger }                from '../utils/logger.js';
import { makeTools }             from './enrichment-tools.js';
import type { EnrichmentJobData } from '../types/index.js';

const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency pitching software development services.

GOAL: qualify companies only if they match this ICP:
- funded startup or scale-up
- relatively new; prefer founded in the last 12 years
- not a big MNC or enterprise
- not India-headquartered
- actively hiring development or engineering roles
- already showing Indian-origin engineers or developers on the team

Collect:
1. tech stack
2. employee count, funding stage, and any age/startup signal
3. key decision-maker contacts for outreach
4. Indian-origin engineer signal and ratio
5. whether the company should be disqualified

RULES:
- always start with get_company_state
- if a tool returns { available: false }, skip it and move on
- use playwright_scrape_url aggressively on /team, /about, /careers, /engineering, /jobs, /contact
- disqualify immediately if the company is defunct, India-headquartered, above 1000 employees, obviously an old enterprise, or shows no engineering hiring signal
- if funding is unknown after multiple sources, treat that as a weak fit and prefer other companies
- always save partial data

Best source order:
1. enrich_github
2. scrape_website_team
3. enrich_explorium
4. enrich_clay
5. playwright_scrape_url
6. enrich_clearbit
7. enrich_hunter
8. verify_contacts
9. compute_origin_ratio
10. queue_for_scoring`;

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
    await companyRepository.disqualify(companyId, 'Company is above the target size range for outbound pitching.');
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
Enrich this company against the outreach ICP:

Company ID : ${companyId}
Domain     : ${domain}
Name       : ${company.name}
Website    : ${company.websiteUrl ?? 'unknown'}
Known data : employee count=${company.employeeCount ?? 'unknown'}, tech stack=${JSON.stringify(company.techStack ?? [])}, status=${company.status}

Steps:
1. Call get_company_state first to see what's already available.
2. Verify funding, company size, and whether the company is relatively new.
3. Verify it is not India-headquartered.
4. Verify active development or engineering hiring.
5. Gather decision-maker contacts and collect names for Indian-origin engineer analysis.
6. Disqualify if it is a big MNC, old enterprise, India-based, unfunded/weak-fit, or not hiring engineers.
7. When enrichment is done, call compute_origin_ratio then queue_for_scoring.
`.trim();

  const agentName    = `enrichment:${domain}`;
  const agentTools   = makeTools(job);
  const maxIterations = 18;

  try {
    const llm   = await buildLlm();
    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: SYSTEM_PROMPT });
    logger.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
    );

    let iterations = 0;
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
        if (p?.['error']) logger.warn({ agent: agentName, tool: msg.name, error: p['error'] }, '[agent] Tool returned error');
        else if (p?.['available'] === false) logger.info({ agent: agentName, tool: msg.name, reason: p['reason'] }, '[agent] Tool unavailable');
        else logger.debug({ agent: agentName, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) }, '[agent] Tool result');
      }
    }
    if (iterations >= maxIterations) logger.warn({ agent: agentName, iterations, maxIterations }, '[agent] Hit max iterations');

    logger.info({ domain, iterations, durationMs: Date.now() - startedAt }, '[enrichment.agent] Complete');
  } catch (err) {
    logger.error({ err, domain }, '[enrichment.agent] Failed');
    await alertAgentFailure({ agent: `enrichment:${domain}`, runId, error: err });
    throw err;
  }
}
