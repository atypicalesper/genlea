import { createAgent }                          from 'langchain';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import { buildLlm, alertAgentFailure, scrapeLogRepository, logger } from '@genlea/shared';
import type { DiscoveryJobData, AgentStep }     from '@genlea/shared';
import { makeTools, buildSystemPrompt }         from './discovery-tools.js';

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

Primary source : ${source}
Keywords       : ${query.keywords}
Location       : ${query.location ?? 'United States'}
Target         : ≥15 companies

Start with get_discovery_state to check current progress. If the goal is not met, scrape ${source} first.
Prefer: SaaS, AI/ML, Fintech, HealthTech, DevTools. Size 10–200, founded 2018+, pre-seed to Series C.
`.trim();

  const agentName     = `discovery:${source}:${runId.slice(0, 8)}`;
  const agentTools    = makeTools(job);
  const maxIterations = 14;

  try {
    const llm   = await buildLlm();
    const agent = createAgent({ model: llm, tools: agentTools, systemPrompt: buildSystemPrompt() });
    logger.info({ agent: agentName, tools: agentTools.map(t => t.name) }, '[agent] Starting');

    const agentResult = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
    );

    let iterations  = 0;
    let totalSaved  = 0;
    const errors: string[]     = [];
    const agentSteps: AgentStep[] = [];

    // Build a tool→callTime map so each ToolMessage can be timestamped
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

        // Accumulate saved count from all save_companies calls
        if (msg.name === 'save_companies' && typeof p?.['runningTotal'] === 'number') {
          totalSaved = p['runningTotal'] as number;
        }

        // Build human-readable summary for this step
        const summary = buildStepSummary(msg.name, p);
        agentSteps.push({ tool: msg.name, summary, ts });

        if (p?.['error'] && !p?.['alreadyTried']) {
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

    // Correct status: success only when ≥1 company saved and no errors
    let status: import('@genlea/shared').ScrapeJobStatus;
    if (totalSaved > 0 && errors.length === 0) {
      status = 'success';
    } else if (totalSaved > 0) {
      status = 'partial';  // saved some but hit errors too
    } else if (errors.length > 0) {
      status = 'failed';   // errors and nothing saved
    } else {
      status = 'partial';  // ran clean but all results filtered — not a hard failure
    }

    await scrapeLogRepository.complete(logId, {
      status,
      companiesFound: totalSaved,
      contactsFound:  0,
      jobsFound:      0,
      errors,
      durationMs:     Date.now() - startedAt,
      agentSteps,
    });

    logger.info({ runId, source, saved: totalSaved, iterations, durationMs: Date.now() - startedAt }, '[discovery.agent] Complete');
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

function buildStepSummary(tool: string, p: Record<string, unknown>): string {
  if (p?.['error'])         return `error: ${String(p['error']).slice(0, 120)}`;
  if (p?.['available'] === false) return `unavailable: ${String(p['reason'] ?? 'no credential')}`;
  if (p?.['alreadyTried'])  return 'skipped — already tried this run';

  switch (tool) {
    case 'get_discovery_state':
      return `state: ${p['companiesFound'] ?? 0}/${p['goalTarget'] ?? 15} companies — goalMet: ${p['goalMet'] ?? false}`;
    case 'check_source_availability':
      return `${p['source']}: ${p['available'] ? 'available' : 'unavailable'}`;
    case 'scrape_source':
      return `scraped ${p['source'] ?? '?'}: ${p['rawCount'] ?? 0} raw → ${p['filteredCount'] ?? 0} after filter`;
    case 'save_companies': {
      const saved  = p['saved']  ?? 0;
      const skip   = p['skipped'] ?? 0;
      const watch  = p['watchlisted'] ?? 0;
      const total  = p['runningTotal'] ?? 0;
      return `saved ${saved}, watchlisted ${watch}, skipped ${skip} — running total: ${total}`;
    }
    default:
      return JSON.stringify(p).slice(0, 100);
  }
}
