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

const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency that sells offshore Indian developer talent to US/UK/CA/EU tech startups.

Your job: given a company domain, gather comprehensive data about:
1. Tech stack (languages, frameworks, tools they use)
2. Employee count and funding stage
3. Key decision-maker contacts — CEO, CTO, VP of Engineering, Head of Engineering, Director of Engineering, HR, Head of Talent, Recruiter. Save ALL of them as a rich array with name, role, email, LinkedIn URL.
4. Indian-origin developer ratio (what fraction of their engineers appear to be of Indian origin)
5. Whether the company is still active and worth pursuing

CRITICAL — availability rule:
If a tool returns { available: false }, skip it immediately — do NOT retry it. Some tools require API keys that may not be configured. In that case, playwright_scrape_url is your primary data source; it requires no API key and works for any URL.

Decision rules:
- ALWAYS start with get_company_state.
- enrich_github is free and always worth trying — great for tech stack + dev names.
- scrape_website_team is free — always try it.
- If enrich_clearbit returns available:false → skip it; use playwright_scrape_url on the company homepage to find employee count, funding info, description instead.
- If enrich_hunter returns available:false → skip it; use playwright_scrape_url on /team, /about, /contact, /people pages to collect emails and names.
- If tech stack is still missing → playwright_scrape_url on /careers, /jobs, /stack, /engineering pages.
- Mark DEFUNCT and stop if: DNS failure, 404, parked page, or shutdown language detected.
- Mark DISQUALIFIED if: employee count > 1000, or HQ is India/non-target country.
- When sufficient data is collected (tech stack + ≥5 names for ratio OR 1+ contact), proceed to scoring.
- Always save partial data — partial data is better than nothing.

Source order (skip if available:false):
1. get_company_state — always first
2. enrich_explorium — best single source: returns company metadata + contacts with email/phone/LinkedIn in one call (requires EXPLORIUM_API_KEY)
3. enrich_clay — requires CLAY_API_KEY — returns company + decision-maker contacts with verified emails; great complement to Explorium
4. enrich_github — free, no key required — great for tech stack + dev names
5. enrich_clearbit — requires CLEARBIT_API_KEY — skip if Explorium or Clay already returned metadata
6. scrape_website_team — free, no key required
7. playwright_scrape_url — free, no key required — use aggressively on /team /about /careers /contact
8. enrich_hunter — requires HUNTER_API_KEY — skip if Explorium or Clay already returned contacts
9. verify_contacts — SMTP verify + fill gaps
10. compute_origin_ratio — after gathering names
11. save_company_data — save partial results anytime
12. disqualify_company — if company should be excluded
13. queue_for_scoring — when enrichment is complete`;

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
Website    : ${company.websiteUrl ?? 'unknown'}
Known data : employee count=${company.employeeCount ?? 'unknown'}, tech stack=${JSON.stringify(company.techStack ?? [])}, status=${company.status}

Steps:
1. Call get_company_state first to see what's already available.
2. Fill ALL missing fields — if data is insufficient, try every available source.
3. Gather decision-maker contacts (CEO, CTO, VP Engineering, Head of Engineering, HR) and save them all as a detailed array via save_contacts.
4. Collect as many names as possible for Indian-origin ratio analysis (target ≥ 10 names).
5. Disqualify immediately if company is defunct or too large.
6. When enrichment is done, call compute_origin_ratio then queue_for_scoring.
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
