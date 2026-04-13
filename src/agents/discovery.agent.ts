/**
 * Discovery Agent
 *
 * Given a search query, the agent autonomously decides:
 *   - Which sources to try (and in what order)
 *   - Whether to expand to more sources if results are thin
 *   - How to handle failures (retry different source, adjust keywords)
 *   - When enough companies have been found
 *
 * Workers call runDiscoveryAgent() — no manual intervention needed.
 */

import { createAgent }           from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { buildLlm }              from './llm.client.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { scrapeLogRepository }   from '../storage/repositories/scrape-log.repository.js';
import { logger }                from '../utils/logger.js';
import { makeTools, buildSystemPrompt } from './discovery-tools.js';
import type { DiscoveryJobData }  from '../types/index.js';

export async function runDiscoveryAgent(job: DiscoveryJobData): Promise<void> {
  const { runId, source, query } = job;

  const logId = (await scrapeLogRepository.create({
    runId, scraper: source, status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt: new Date(),
  }))._id!;

  const startedAt = Date.now();

  const userMessage = `
Find tech companies for B2B lead generation.

Primary source: ${source}
Keywords: ${query.keywords}
Location: ${query.location ?? 'United States'}
Target limit: ${query.limit ?? 25} companies

Start with ${source}. If you get fewer than 5 results or it fails, expand to other sources using similar keywords.
Prefer companies in: SaaS, AI/ML, BioTech, Fintech, HealthTech, DevTools.
Target size: 10–200 employees. Age: founded 2018–present (up to ~7 years old). Funding: pre-seed to Series C.
A company founded 5–6 years ago that's actively hiring engineers is a perfect lead — do not skip it just because it's not "early stage".
`.trim();

  const agentName    = `discovery:${source}:${runId.slice(0, 8)}`;
  const agentTools   = makeTools(job);
  const maxIterations = 12;

  try {
    const llm   = await buildLlm();
    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: buildSystemPrompt() });
    logger.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
    );

    const toolResults = new Map<string, unknown>();
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
        toolResults.set(msg.name, parsed);
        const p = parsed as Record<string, unknown>;
        if (p?.['error']) logger.warn({ agent: agentName, tool: msg.name, error: p['error'] }, '[agent] Tool returned error');
        else if (p?.['available'] === false) logger.info({ agent: agentName, tool: msg.name, reason: p['reason'] }, '[agent] Tool unavailable');
        else logger.debug({ agent: agentName, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) }, '[agent] Tool result');
      }
    }
    if (iterations >= maxIterations) logger.warn({ agent: agentName, iterations, maxIterations }, '[agent] Hit max iterations');
    logger.info({ agent: agentName, iterations }, '[agent] Complete');

    const saveResult = toolResults.get('save_companies') as { saved?: number } | undefined;
    const saved = saveResult?.saved ?? 0;

    await scrapeLogRepository.complete(logId, {
      status: 'success',
      companiesFound: saved,
      contactsFound:  0,
      jobsFound:      0,
      errors:         [],
      durationMs:     Date.now() - startedAt,
    });

    logger.info({ runId, source, saved, iterations }, '[discovery.agent] Complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound: 0, contactsFound: 0, jobsFound: 0,
      errors: [msg], durationMs: Date.now() - startedAt,
    }).catch(() => {});
    logger.error({ err, runId, source }, '[discovery.agent] Failed');
    await alertAgentFailure({ agent: `discovery:${source}`, runId, error: err });
    throw err;
  }
}
