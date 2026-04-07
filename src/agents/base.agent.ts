/**
 * LangGraph agentic loop.
 *
 * Wraps `createReactAgent` — tool-calling loop that runs until the model
 * produces a final response with no tool calls, or `maxIterations` is hit.
 *
 * Single responsibility: orchestrate the agent loop and surface results.
 * All tool definitions and handlers live in the concrete agent files.
 */

import { createReactAgent }            from '@langchain/langgraph/prebuilt';
import { HumanMessage, AIMessage, ToolMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { buildLlm }                    from './llm.client.js';
import { logger }                      from '../utils/logger.js';

export interface AgentRunOptions {
  name:          string;
  systemPrompt:  string;
  tools:         StructuredToolInterface[];
  userMessage:   string;
  maxIterations?: number;
}

export interface AgentResult {
  finalMessage: string;
  iterations:   number;
  toolResults:  Map<string, unknown>;
}

export async function runAgent({
  name,
  systemPrompt,
  tools,
  userMessage,
  maxIterations = 15,
}: AgentRunOptions): Promise<AgentResult> {
  const llm = await buildLlm();

  const agent = createReactAgent({ llm, tools, stateModifier: systemPrompt });

  logger.info({ agent: name, tools: tools.map(t => t.name) }, '[agent] Starting');

  let result: Awaited<ReturnType<typeof agent.invoke>>;
  try {
    result = await agent.invoke(
      { messages: [new HumanMessage(userMessage)] },
      { recursionLimit: maxIterations * 2 + 4 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const cause = (err as any)?.cause;
    logger.error(
      { agent: name, error: msg, cause: cause ? String(cause) : undefined, stack: err instanceof Error ? err.stack : undefined },
      '[agent] LLM/graph invocation failed',
    );
    throw err;
  }

  const toolResults = new Map<string, unknown>();
  let iterations = 0;

  for (const msg of result.messages as (AIMessage | ToolMessage)[]) {
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
      iterations++;

      // Log every tool call the model decided to make
      for (const call of msg.tool_calls) {
        logger.debug(
          { agent: name, iter: iterations, tool: call.name, args: call.args },
          '[agent] Tool call',
        );
      }
    }

    if (msg instanceof ToolMessage && msg.name) {
      let parsed: unknown = msg.content;
      try { parsed = JSON.parse(msg.content as string); } catch { /* leave as string */ }

      toolResults.set(msg.name, parsed);

      // Detect error payloads returned by tool handlers and log them at warn level
      // so they are visible in the log stream even when the LLM handles them gracefully.
      if (
        parsed && typeof parsed === 'object' &&
        ('error' in parsed || 'available' in (parsed as any))
      ) {
        const p = parsed as Record<string, unknown>;
        if (p['error']) {
          logger.warn(
            { agent: name, tool: msg.name, error: p['error'] },
            '[agent] Tool returned error',
          );
        } else if (p['available'] === false) {
          logger.info(
            { agent: name, tool: msg.name, reason: p['reason'] },
            '[agent] Tool unavailable — skipping',
          );
        }
      } else {
        logger.debug(
          { agent: name, tool: msg.name, resultPreview: JSON.stringify(parsed).slice(0, 120) },
          '[agent] Tool result',
        );
      }
    }
  }

  if (iterations >= maxIterations) {
    logger.warn(
      { agent: name, iterations, maxIterations },
      '[agent] Hit max iterations — agent may not have completed all tasks',
    );
  }

  const lastAI = [...result.messages].reverse().find(m => m instanceof AIMessage);
  const finalMessage = typeof lastAI?.content === 'string' ? lastAI.content : '';

  logger.info({ agent: name, iterations }, '[agent] Complete');
  return { finalMessage, iterations, toolResults };
}
