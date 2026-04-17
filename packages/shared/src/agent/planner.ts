import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { buildLlm } from '../utils/llm.client.js';
import { buildContext } from './memory.js';
import { logger } from '../utils/logger.js';
import type { AgentMemory } from './memory.js';
import type { DomSummary } from './dom-summarizer.js';

const ActionSchema = z.object({
  action:    z.string().min(1),
  input:     z.record(z.unknown()).default({}),
  reasoning: z.string().min(1),
});

export type AgentAction = z.infer<typeof ActionSchema>;

// LLM never writes code — it only outputs the action name + inputs as JSON.
const SYSTEM_PROMPT = `You are an autonomous web agent. Decide the SINGLE next action to take.

Respond with ONLY a valid JSON object — no other text:
{
  "action": "<tool_name>",
  "input": { ... },
  "reasoning": "<one sentence why>"
}

Termination actions (no input needed):
- "done"  → goal fully achieved
- "fail"  → goal cannot be completed

Rules:
- ONE action per response
- Never guess selectors — only use selectors from the DOM summary inputs list
- Never generate code
- Keep reasoning under 100 chars`;

export async function planNextAction(
  memory: AgentMemory,
  dom: DomSummary,
  availableTools: string[],
): Promise<AgentAction> {
  const llm = await buildLlm();

  const prompt = [
    buildContext(memory),
    '',
    'Current DOM:',
    JSON.stringify(dom, null, 2),
    '',
    `Available tools: ${[...availableTools, 'done', 'fail'].join(', ')}`,
    '',
    'Respond with ONE JSON action only.',
  ].join('\n');

  const response = await llm.invoke([
    new SystemMessage(SYSTEM_PROMPT),
    new HumanMessage(prompt),
  ]);

  const raw = typeof response.content === 'string'
    ? response.content
    : JSON.stringify(response.content);

  // Strip markdown code fences if the LLM wraps the JSON
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();

  try {
    return ActionSchema.parse(JSON.parse(json));
  } catch {
    logger.warn({ raw: raw.slice(0, 300) }, '[planner] Invalid JSON from LLM — forcing fail');
    return { action: 'fail', input: {}, reasoning: `LLM returned unparseable output: ${raw.slice(0, 120)}` };
  }
}
