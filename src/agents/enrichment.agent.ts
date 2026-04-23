/**
 * Enrichment Agent
 *
 * Given a company, the agent autonomously decides:
 *   - What data is already available (get_company_state)
 *   - Which enrichment sources to try and in what order
 *   - When to use Playwright stealth as a fallback after Hunter / free sources
 *   - Whether the company should be disqualified (defunct, too large, wrong country)
 *   - When enough data has been gathered to proceed to scoring
 *   - If data is insufficient, it tries the Hunter-first toolset before giving up
 *
 * Workers call runEnrichmentAgent() — no manual intervention needed.
 */

import { createAgent }           from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { getLlm, buildLlmInvokeOptions } from './llm.client.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { companyRepository }     from '../storage/repositories/company.repository.js';
import { queueManager }          from '../core/queue.manager.js';
import { createLogger, getLlmTag } from '../utils/logger.js';
import { makeTools }             from './enrichment-tools.js';
import type { EnrichmentJobData } from '../types/index.js';

// The stable system prompt carries most of the expensive repeated context.
const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency pitching software development services.

GOAL: qualify companies only if they match this ICP:
- funded or promising enough to buy external engineering help
- not a big MNC or enterprise
- not India-headquartered
- actively hiring development or engineering roles
- already showing Indian-origin engineers or developers on the team

Collect:
1. tech stack
2. employee count and basic company profile details
3. funding or growth-stage signals when available
4. key decision-maker contacts for outreach
5. Indian-origin engineer signal and ratio
6. whether the company should be disqualified

RULES:
- always start with get_company_state
- if a tool returns { available: false }, skip it and move on
- use playwright_scrape_url aggressively on /team, /about, /careers, /engineering, /jobs, /contact
- if get_company_state shows activeJobsCount=0, call check_company_hiring before disqualifying for no hiring signal
- disqualify immediately if the company is defunct, India-headquartered, above 1000 employees, or shows no engineering hiring signal
- always save partial data

Best source order:
1. enrich_github
2. scrape_website_team
3. enrich_hunter
4. check_company_hiring
5. playwright_scrape_url
6. verify_contacts
7. compute_origin_ratio
8. queue_for_scoring`;

// Keep the user prompt small and structured so Anthropic can reuse the shared prefix.
const USER_PROMPT_TEMPLATE = [
  'Enrich this company against the outreach ICP.',
  'Start with get_company_state.',
  'Verify non-India HQ, company size, funding or growth-stage signal, and engineering hiring.',
  'Use Hunter as the only API enrichment source for contacts and email discovery.',
  'Use GitHub, website scraping, and Playwright only as non-API support for tech stack, hiring, and names.',
  'If activeJobsCount is zero, call check_company_hiring before deciding there is no hiring signal.',
  'Gather decision-maker contacts and names for Indian-origin engineer analysis.',
  'Disqualify if big MNC, India-based, defunct, above 1000 employees, or not hiring engineers.',
  'When enough data is available, call compute_origin_ratio and queue_for_scoring.',
].join('\n');

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export async function runEnrichmentAgent(job: EnrichmentJobData): Promise<void> {
  const { runId, companyId, domain, force } = job;
  const startedAt = Date.now();

  const company = await companyRepository.findById(companyId);
  const log = createLogger({ phase: 'enrichment', source: domain, llm: getLlmTag() });

  if (!company) {
    log.warn({ companyId, domain }, '[enrichment.agent] Company not found — skipping');
    return;
  }

  if (company.status === 'disqualified' && company.manuallyReviewed) {
    log.info({ companyId, domain }, '[enrichment.agent] Manually disqualified — skipping');
    await companyRepository.setPipelineStatus(companyId, 'scored');
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
      log.info({ domain, ageHours: (ageMs / 3_600_000).toFixed(1) }, '[enrichment.agent] Cooldown — queuing scoring only');
      await queueManager.addScoringJob({ runId, companyId });
      return;
    }
  }

  const userMessage = [
    USER_PROMPT_TEMPLATE,
    `companyId=${companyId}`,
    `domain=${domain}`,
    `name=${company.name}`,
    `website=${company.websiteUrl ?? 'unknown'}`,
    `employeeCount=${company.employeeCount ?? 'unknown'}`,
    `fundingStage=${company.fundingStage ?? 'unknown'}`,
    `techStack=${JSON.stringify(company.techStack ?? [])}`,
    `status=${company.status}`,
  ].join('\n');

  const agentName    = `enrichment:${domain}`;
  const agentTools   = makeTools(job);
  const maxIterations = 18;

  try {
    const llm   = await getLlm();

    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: SYSTEM_PROMPT });
    log.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4, ...buildLlmInvokeOptions() },
    );

    let iterations = 0;
    for (const msg of agentResult.messages as (AIMessage | ToolMessage)[]) {
      if (msg instanceof AIMessage && msg.tool_calls?.length) {
        iterations++;

        for (const call of msg.tool_calls) {
          log.debug({ agent: agentName, iter: iterations, tool: call.name, args: call.args }, '[agent] Tool call');
        }
      }

      if (msg instanceof ToolMessage && msg.name) {
        let parsed: unknown = msg.content;
        try { parsed = JSON.parse(msg.content as string); } catch { /* leave as string */ }

        const p = parsed as Record<string, unknown>;

        if (p?.['error']) log.warn({ agent: agentName, tool: msg.name, error: p['error'] }, '[agent] Tool returned error');
        else if (p?.['available'] === false) log.info({ agent: agentName, tool: msg.name, reason: p['reason'] }, '[agent] Tool unavailable');
        else log.debug({ agent: agentName, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) }, '[agent] Tool result');
      }
    }
    if (iterations >= maxIterations) log.warn({ agent: agentName, iterations, maxIterations }, '[agent] Hit max iterations');

    log.info({ domain, iterations, durationMs: Date.now() - startedAt }, '[enrichment.agent] Complete');
  } catch (err) {
    log.error({ err, domain }, '[enrichment.agent] Failed');
    await alertAgentFailure({ agent: `enrichment:${domain}`, runId, error: err });
    throw err;
  }
}
