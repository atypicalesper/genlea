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
  /** Final text response from the model (after all tool calls). */
  finalMessage: string;
  /** Number of LLM → tool-call iterations completed. */
  iterations:   number;
  /**
   * Last result for each tool that was called, keyed by tool name.
   * Multiple calls to the same tool keep only the last result.
   */
  toolResults: Map<string, unknown>;
}

export async function runAgent({
  name,
  systemPrompt,
  tools,
  userMessage,
  maxIterations = 15,
}: AgentRunOptions): Promise<AgentResult> {
  const llm = await buildLlm();

  const agent = createReactAgent({
    llm,
    tools,
    stateModifier: systemPrompt,
  });

  logger.info({ agent: name, tools: tools.map(t => t.name) }, '[agent] Starting');

  const result = await agent.invoke(
    { messages: [new HumanMessage(userMessage)] },
    // Each full iteration = 1 agent node + 1 tools node = 2 graph steps.
    // Add headroom for the final LLM response (no tool call).
    { recursionLimit: maxIterations * 2 + 4 },
  );

  // Extract tool results and count meaningful iterations from message history.
  const toolResults = new Map<string, unknown>();
  let iterations = 0;

  for (const msg of result.messages as (AIMessage | ToolMessage)[]) {
    if (msg instanceof AIMessage && msg.tool_calls && msg.tool_calls.length > 0) {
      iterations++;
    }
    if (msg instanceof ToolMessage && msg.name) {
      try {
        toolResults.set(msg.name, JSON.parse(msg.content as string));
      } catch {
        toolResults.set(msg.name, msg.content);
      }
    }
  }

  const lastAI = [...result.messages].reverse().find(m => m instanceof AIMessage);
  const finalMessage = typeof lastAI?.content === 'string' ? lastAI.content : '';

  logger.info({ agent: name, iterations }, '[agent] Complete');
  return { finalMessage, iterations, toolResults };
}
