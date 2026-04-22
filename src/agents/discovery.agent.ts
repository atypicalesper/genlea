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
import { recordResult }          from '../discovery/source-health.js';
import { createLogger, getLlmTag } from '../utils/logger.js';
import { makeTools, buildSystemPrompt } from './discovery-tools.js';
import type { DiscoveryJobData, ScrapeDiagnosticsSummary }  from '../types/index.js';

export async function runDiscoveryAgent(job: DiscoveryJobData): Promise<void> {
  const { runId, source, query } = job;

  const logId = (await scrapeLogRepository.create({
    runId, scraper: source, status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt: new Date(),
  }))._id!;

  const startedAt = Date.now();

  const userMessage = `
Find companies that fit this outreach ICP.

Primary source: ${source}
Keywords: ${query.keywords}
Location: ${query.location ?? 'United States'}
Target: ≥15 companies

Start with get_discovery_state to check current progress. If goal not met, scrape ${source} first.
After each scrape_source, immediately call save_companies with source="${source}" — do NOT pass company data, just the source name.
Focus on non-India companies that are hiring development or engineering roles.
Avoid big MNCs, avoid companies above 1000 employees, and prefer companies likely to already employ Indian-origin engineers.
`.trim();

  const agentName    = `discovery:${source}:${runId.slice(0, 8)}`;
  const agentTools   = makeTools(job);
  const maxIterations = 12;
  const log = createLogger({ phase: 'discovery', source, llm: getLlmTag() });

  try {
    const llm   = await buildLlm();
    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: buildSystemPrompt() });
    log.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

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
          log.debug({ agent: agentName, iter: iterations, tool: call.name, args: call.args }, '[agent] Tool call');
        }
      }
      if (msg instanceof ToolMessage && msg.name) {
        // Keep the last payload per tool so we can summarize the run without replaying tool logic.
        let parsed: unknown = msg.content;
        try { parsed = JSON.parse(msg.content as string); } catch { /* leave as string */ }
        toolResults.set(msg.name, parsed);
        const p = parsed as Record<string, unknown>;
        if (p?.['error']) log.warn({ agent: agentName, tool: msg.name, error: p['error'] }, '[agent] Tool returned error');
        else if (p?.['available'] === false) log.info({ agent: agentName, tool: msg.name, reason: p['reason'] }, '[agent] Tool unavailable');
        else log.debug({ agent: agentName, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) }, '[agent] Tool result');
      }
    }
    if (iterations >= maxIterations) log.warn({ agent: agentName, iterations, maxIterations }, '[agent] Hit max iterations');
    log.info({ agent: agentName, iterations }, '[agent] Complete');

    const saveResult = toolResults.get('save_companies') as { saved?: number } | undefined;
    const scrapeResult = toolResults.get('scrape_source') as { diagnostics?: ScrapeDiagnosticsSummary } | undefined;
    const saved = saveResult?.saved ?? 0;
    const diagnostics = scrapeResult?.diagnostics;

    const status =
      saved > 0 ? 'success'
      : diagnostics?.outcome === 'captcha' || diagnostics?.outcome === 'blocked' || diagnostics?.outcome === 'network_error' || diagnostics?.outcome === 'timeout'
        ? 'failed'
        : 'partial';

    await scrapeLogRepository.complete(logId, {
      status,
      companiesFound: saved,
      contactsFound:  0,
      jobsFound:      0,
      errors:         [],
      durationMs:     Date.now() - startedAt,
      diagnostics,
    });
    recordResult(source, saved);

    log.info({ runId, source, saved, iterations }, '[discovery.agent] Complete');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound: 0, contactsFound: 0, jobsFound: 0,
      errors: [msg], durationMs: Date.now() - startedAt,
    }).catch(() => {});
    recordResult(source, 0);
    log.error({ err, runId, source }, '[discovery.agent] Failed');
    await alertAgentFailure({ agent: `discovery:${source}`, runId, error: err });
    throw err;
  }
}
