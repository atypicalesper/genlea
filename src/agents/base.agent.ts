/**
 * Base agentic loop.
 *
 * Runs a tool-use loop until:
 *   - The LLM stops calling tools (end_turn)
 *   - A tool calls `signal_done`
 *   - MAX_ITERATIONS is reached (safety guard)
 */

import { llmChat, toolResult, LLMMessage, ToolDef, ToolCall } from './llm.client.js';
export type { ToolDef, ToolCall } from './llm.client.js';
import { logger } from '../utils/logger.js';

export type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

export interface AgentConfig {
  name: string;
  systemPrompt: string;
  tools: ToolDef[];
  handlers: Record<string, ToolHandler>;
  maxIterations?: number;
}

export interface AgentResult {
  iterations: number;
  finalMessage: string;
  toolCallLog: Array<{ tool: string; args: Record<string, unknown>; result: unknown }>;
}

const DONE_TOOL = 'signal_done';

const DONE_TOOL_DEF: ToolDef = {
  name: DONE_TOOL,
  description: 'Signal that you have finished your task. Call this when all work is complete.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Brief summary of what was accomplished' },
    },
    required: ['summary'],
  },
};

const TOOL_RESULT_MAX_CHARS = 600;

/**
 * Slim down a tool result before appending to message history.
 * The LLM already reasoned over the full result — subsequent iterations
 * only need a short summary to maintain context, not the full payload.
 */
function truncateToolResult(result: unknown, toolName: string): unknown {
  const json = typeof result === 'string' ? result : JSON.stringify(result);
  if (json.length <= TOOL_RESULT_MAX_CHARS) return result;

  // For scrape_source: keep counts + first 3 company names only
  if (toolName === 'scrape_source' && typeof result === 'object' && result !== null) {
    const r = result as Record<string, unknown>;
    const companies = (r['companies'] as unknown[]) ?? [];
    return {
      source:         r['source'],
      rawCount:       r['rawCount'],
      filteredCount:  r['filteredCount'],
      companies:      companies.slice(0, 3).map((c: any) => ({ name: c.name, domain: c.domain })),
      truncated:      `${companies.length} companies total — first 3 shown`,
    };
  }

  // Generic fallback: truncate JSON string
  return { _truncated: json.slice(0, TOOL_RESULT_MAX_CHARS) + `… [${json.length} chars total]` };
}

export async function runAgent(
  config: AgentConfig,
  userMessage: string,
): Promise<AgentResult> {
  const maxIter = config.maxIterations ?? 15;
  const allTools = [...config.tools, DONE_TOOL_DEF];

  const messages: LLMMessage[] = [
    { role: 'system',  content: config.systemPrompt },
    { role: 'user',    content: userMessage },
  ];

  const toolCallLog: AgentResult['toolCallLog'] = [];
  let iterations = 0;
  let finalMessage = '';

  logger.info({ agent: config.name, userMessage: userMessage.slice(0, 120) }, '[agent] Starting');

  while (iterations < maxIter) {
    iterations++;

    const response = await llmChat(messages, allTools);
    finalMessage = response.content;

    logger.debug(
      { agent: config.name, iter: iterations, stopReason: response.stopReason, toolCalls: response.toolCalls.map(t => t.name) },
      '[agent] LLM response'
    );

    // Append assistant turn to history
    messages.push({
      role: 'assistant',
      content: response.content,
      tool_calls: response.toolCalls.length
        ? response.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function' as const,
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          }))
        : undefined,
    });

    if (response.stopReason === 'end_turn' || response.toolCalls.length === 0) {
      logger.info({ agent: config.name, iterations }, '[agent] Done — end_turn');
      break;
    }

    // Execute each tool call
    for (const call of response.toolCalls) {
      if (call.name === DONE_TOOL) {
        finalMessage = String((call.args as { summary?: string }).summary ?? 'Done');
        logger.info({ agent: config.name, iterations, summary: finalMessage }, '[agent] signal_done');
        return { iterations, finalMessage, toolCallLog };
      }

      const handler = config.handlers[call.name];
      let result: unknown;

      if (!handler) {
        result = { error: `Unknown tool: ${call.name}` };
        logger.warn({ agent: config.name, tool: call.name }, '[agent] Unknown tool called');
      } else {
        try {
          result = await handler(call.args);
          logger.debug({ agent: config.name, tool: call.name }, '[agent] Tool executed');
        } catch (err) {
          result = { error: err instanceof Error ? err.message : String(err) };
          logger.warn({ agent: config.name, tool: call.name, err }, '[agent] Tool error');
        }
      }

      toolCallLog.push({ tool: call.name, args: call.args, result });
      // Truncate large tool results in message history — LLM already reasoned over
      // the full result; keeping a slim summary prevents history bloat across iterations.
      const resultForHistory = truncateToolResult(result, call.name);
      messages.push(toolResult(call.id, call.name, resultForHistory));
    }
  }

  if (iterations >= maxIter) {
    logger.warn({ agent: config.name, iterations }, '[agent] Max iterations reached');
  }

  return { iterations, finalMessage, toolCallLog };
}
