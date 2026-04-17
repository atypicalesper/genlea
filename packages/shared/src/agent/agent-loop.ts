import type { Page } from 'playwright';
import { summarizeDom } from './dom-summarizer.js';
import { planNextAction } from './planner.js';
import { executeAction, createDefaultPlaywrightTools } from './executor.js';
import { createMemory, recordStep } from './memory.js';
import { wrapTraceable } from './langsmith.js';
import { logger } from '../utils/logger.js';
import type { ToolRegistry } from './executor.js';

export interface AgentLoopOptions {
  maxSteps?:    number;  // default 15
  maxRetries?:  number;  // consecutive failures before abort, default 2
  timeoutMs?:   number;  // wall-clock timeout, default 5 min
  extraTools?:  ToolRegistry;
}

export interface AgentLoopResult {
  success: boolean;
  steps:   number;
  reason:  string;
  state:   Record<string, unknown>;
}

async function _runAgentLoop(
  goal: string,
  page: Page,
  opts: AgentLoopOptions,
): Promise<AgentLoopResult> {
  const { maxSteps = 15, maxRetries = 2, timeoutMs = 5 * 60_000, extraTools = {} } = opts;

  const tools    = { ...createDefaultPlaywrightTools(), ...extraTools };
  const toolKeys = Object.keys(tools);
  const memory   = createMemory(goal);
  const deadline = Date.now() + timeoutMs;

  let step    = 0;
  let retries = 0;

  while (step < maxSteps) {
    if (Date.now() > deadline) {
      return { success: false, steps: step, reason: 'Timeout', state: memory.state };
    }

    step++;

    // 1. Read state
    const dom = await summarizeDom(page).catch(err => {
      logger.warn({ err }, '[agent-loop] DOM summarize failed');
      return null;
    });
    if (!dom) return { success: false, steps: step, reason: 'Could not read DOM', state: memory.state };

    memory.url = dom.url;

    // 2. Plan — LLM decides next action from summarized DOM (never raw HTML)
    const action = await planNextAction(memory, dom, toolKeys).catch(err => {
      logger.warn({ err }, '[agent-loop] Planner failed');
      return null;
    });
    if (!action) return { success: false, steps: step, reason: 'Planner returned null', state: memory.state };

    logger.info({ step, action: action.action, reasoning: action.reasoning }, '[agent-loop] Step');

    // 3. Termination checks
    if (action.action === 'done') {
      return { success: true,  steps: step, reason: action.reasoning, state: memory.state };
    }
    if (action.action === 'fail') {
      return { success: false, steps: step, reason: action.reasoning, state: memory.state };
    }

    // 4. Execute
    const result = await executeAction(action, page, tools);
    const resultStr = result.success ? result.output : `ERROR: ${result.error}`;

    // 5. Record into memory (keeps last N steps as rolling context)
    recordStep(memory, action.action, action.input, resultStr);

    // 6. Consecutive retry guard
    if (!result.success) {
      retries++;
      logger.warn({ retries, maxRetries, tool: action.action, error: result.error }, '[agent-loop] Tool failed');
      if (retries > maxRetries) {
        return {
          success: false, steps: step,
          reason:  `Aborted after ${retries} consecutive failures. Last: ${result.error}`,
          state:   memory.state,
        };
      }
    } else {
      retries = 0;
    }
  }

  return { success: false, steps: step, reason: `Max steps (${maxSteps}) reached`, state: memory.state };
}

// Wrap the loop with LangSmith tracing when enabled.
// Each goal becomes a named run in LangSmith — every LLM call inside is a child span.
export const runAgentLoop = wrapTraceable(
  'agent-loop',
  _runAgentLoop,
  { project: process.env['LANGCHAIN_PROJECT'] ?? 'genlea' },
);
