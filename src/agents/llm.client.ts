/**
 * Provider-agnostic LLM client with tool-use support.
 *
 * AGENT_LLM_PROVIDER=groq        → uses groq-sdk  (default, GROQ_API_KEY required)
 * AGENT_LLM_PROVIDER=anthropic   → uses @anthropic-ai/sdk (ANTHROPIC_API_KEY required)
 *
 * AGENT_LLM_MODEL overrides the default model for the selected provider.
 * Groq default  : llama-3.1-8b-instant (500k TPD free tier; set AGENT_LLM_MODEL to override)
 * Anthropic default: claude-haiku-4-5-20251001
 */

import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';

// ── Shared types ──────────────────────────────────────────────────────────────

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema object
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: GroqToolCall[];  // assistant tool calls (provider-internal)
  tool_call_id?: string;        // for role=tool responses
  name?: string;                // for role=tool responses
}

interface GroqToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface LLMResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason: 'end_turn' | 'tool_use' | 'max_tokens' | 'stop';
}

// ── Provider: Groq ────────────────────────────────────────────────────────────

async function groqChat(
  messages: LLMMessage[],
  tools: ToolDef[],
  model: string,
): Promise<LLMResponse> {
  const groq = new Groq({ apiKey: process.env['GROQ_API_KEY'] });

  const groqTools = tools.map(t => ({
    type: 'function' as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  const res = await groq.chat.completions.create({
    model,
    messages: messages as Groq.Chat.Completions.ChatCompletionMessageParam[],
    tools: groqTools.length ? groqTools : undefined,
    tool_choice: groqTools.length ? 'auto' : undefined,
    temperature: 0.2,
    max_tokens: 2048,
  });

  const choice = res.choices[0]!;
  const msg = choice.message;
  const rawCalls = msg.tool_calls ?? [];

  const toolCalls: ToolCall[] = rawCalls.map(tc => ({
    id: tc.id,
    name: tc.function.name,
    args: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
  }));

  return {
    content: msg.content ?? '',
    toolCalls,
    stopReason: choice.finish_reason === 'tool_calls' ? 'tool_use'
              : choice.finish_reason === 'length'     ? 'max_tokens'
              : 'end_turn',
  };
}

// ── Provider: Anthropic ───────────────────────────────────────────────────────
// Install: npm install @anthropic-ai/sdk
// Env:     ANTHROPIC_API_KEY=sk-ant-...
//          AGENT_LLM_PROVIDER=anthropic

async function anthropicChat(
  messages: LLMMessage[],
  tools: ToolDef[],
  model: string,
): Promise<LLMResponse> {
  // Dynamic import — @anthropic-ai/sdk is optional (npm install @anthropic-ai/sdk)
  // @ts-ignore — optional peer dependency, not installed by default
  const { default: Anthropic }: any = await import('@anthropic-ai/sdk').catch(() => {
    throw new Error('Install @anthropic-ai/sdk: npm install @anthropic-ai/sdk');
  });

  const client = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });

  const systemMsg = messages.find(m => m.role === 'system')?.content ?? '';
  const chatMsgs = messages
    .filter(m => m.role !== 'system')
    .map(m => {
      if (m.role === 'tool') {
        return {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: m.tool_call_id!, content: m.content }],
        };
      }
      if (m.role === 'assistant' && m.tool_calls?.length) {
        return {
          role: 'assistant',
          content: m.tool_calls.map(tc => ({
            type: 'tool_use',
            id: tc.id,
            name: tc.function.name,
            input: (() => { try { return JSON.parse(tc.function.arguments); } catch { return {}; } })(),
          })),
        };
      }
      return { role: m.role, content: m.content };
    });

  const anthropicTools = tools.map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));

  const res = await client.messages.create({
    model,
    system: systemMsg,
    messages: chatMsgs,
    tools: anthropicTools.length ? anthropicTools : undefined,
    max_tokens: 2048,
    temperature: 0.2,
  });

  const toolCalls: ToolCall[] = res.content
    .filter((b: { type: string }) => b.type === 'tool_use')
    .map((b: { id: string; name: string; input: Record<string, unknown> }) => ({
      id: b.id, name: b.name, args: b.input,
    }));

  const textContent = res.content
    .filter((b: { type: string }) => b.type === 'text')
    .map((b: { text: string }) => b.text)
    .join('');

  return {
    content: textContent,
    toolCalls,
    stopReason: res.stop_reason === 'tool_use'  ? 'tool_use'
              : res.stop_reason === 'max_tokens' ? 'max_tokens'
              : 'end_turn',
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

const PROVIDER = (process.env['AGENT_LLM_PROVIDER'] ?? 'groq').toLowerCase();

const DEFAULT_MODELS: Record<string, string> = {
  groq:      'llama-3.1-8b-instant',   // 500k TPD free tier (vs 100k for 70b)
  anthropic: 'claude-haiku-4-5-20251001',
};

export const MODEL = process.env['AGENT_LLM_MODEL'] ?? DEFAULT_MODELS[PROVIDER] ?? 'llama-3.3-70b-versatile';

export async function llmChat(
  messages: LLMMessage[],
  tools: ToolDef[],
): Promise<LLMResponse> {
  logger.debug({ provider: PROVIDER, model: MODEL, tools: tools.map(t => t.name) }, '[llm] chat');
  if (PROVIDER === 'anthropic') return anthropicChat(messages, tools, MODEL);
  return groqChat(messages, tools, MODEL);
}

/** Build a tool result message to append after a tool call */
export function toolResult(toolCallId: string, name: string, result: unknown): LLMMessage {
  return {
    role: 'tool',
    tool_call_id: toolCallId,
    name,
    content: typeof result === 'string' ? result : JSON.stringify(result),
  };
}

/** Build an assistant message that contains tool calls (for message history) */
export function assistantWithTools(content: string, toolCalls: GroqToolCall[]): LLMMessage {
  return { role: 'assistant', content, tool_calls: toolCalls };
}
