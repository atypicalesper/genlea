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
import { getLlm, buildLlmInvokeOptions } from './llm.client.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { scrapeLogRepository }   from '../storage/repositories/scrape-log.repository.js';
import { recordResult }          from '../discovery/source-health.js';
import { createLogger, getLlmTag } from '../utils/logger.js';
import { makeTools, buildSystemPrompt } from './discovery-tools.js';
import type { DiscoveryJobData, ScrapeDiagnosticsSummary }  from '../types/index.js';

// Keep the variable tail compact so Anthropic prompt caching can reuse the large
  // shared prefix from the system prompt and tool definitions.
const USER_PROMPT_TEMPLATE = [
  'Run discovery for this source.',
  'Use get_discovery_state first.',
  'Scrape the primary source before trying fallbacks.',
  'After each scrape_source, immediately call save_companies with the same source.',
  'Target ICP: non-India companies, engineering hiring, not big MNCs, prefer Indian-origin employee signal.',
  'Stop once the goal is met.',
].join('\n');

export async function runDiscoveryAgent(job: DiscoveryJobData): Promise<void> {
  const { runId, source, query } = job;

  const logId = (await scrapeLogRepository.create({
    runId, scraper: source, status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt: new Date(),
  }))._id!;

  const startedAt = Date.now();

  const userMessage = [
    USER_PROMPT_TEMPLATE,
    `source=${source}`,
    `keywords=${query.keywords}`,
    `location=${query.location ?? 'United States'}`,
    'goal=15 companies',
  ].join('\n');

  const agentName    = `discovery:${source}:${runId.slice(0, 8)}`;
  const agentTools   = makeTools(job);
  const maxIterations = 12;
  const log = createLogger({ phase: 'discovery', source, llm: getLlmTag() });

  try {
    const llm   = await getLlm();

    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: buildSystemPrompt() });
    log.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4, ...buildLlmInvokeOptions() },
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
