export interface AgentMessage {
  action: string;
  input:  Record<string, unknown>;
  result: string;
  ts:     string;
}

export interface AgentMemory {
  goal:    string;
  url:     string;
  history: AgentMessage[];
  state:   Record<string, unknown>;
}

export function createMemory(goal: string): AgentMemory {
  return { goal, url: '', history: [], state: {} };
}

export function recordStep(
  memory: AgentMemory,
  action: string,
  input: Record<string, unknown>,
  result: string,
): void {
  memory.history.push({ action, input, result, ts: new Date().toISOString() });
}

export function buildContext(memory: AgentMemory, maxHistory = 5): string {
  const recent = memory.history.slice(-maxHistory);
  const steps = recent
    .map(m => `  ${m.action}(${JSON.stringify(m.input)}) → ${m.result.slice(0, 200)}`)
    .join('\n');

  return [
    `Goal: ${memory.goal}`,
    `Current URL: ${memory.url || 'none'}`,
    recent.length > 0 ? `Recent steps:\n${steps}` : 'No steps yet.',
    Object.keys(memory.state).length > 0 ? `State: ${JSON.stringify(memory.state)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}
