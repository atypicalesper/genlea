import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from './logger.js';

const PROVIDER = (process.env['AGENT_LLM_PROVIDER'] ?? 'ollama').toLowerCase();

const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-3-5-haiku-20241022',
};

export const MODEL = process.env['AGENT_LLM_MODEL'] ?? DEFAULT_MODELS[PROVIDER] ?? 'qwen3.5';

export async function buildLlm(): Promise<BaseChatModel> {
  logger.debug({ provider: PROVIDER, model: MODEL }, '[llm] Building LangChain model');

  if (PROVIDER === 'groq') {
    const { ChatGroq } = await import('@langchain/groq');
    return new ChatGroq({
      model:       MODEL,
      apiKey:      process.env['GROQ_API_KEY'],
      temperature: 0.2,
      maxTokens:   8192,
    }) as unknown as BaseChatModel;
  }

  if (PROVIDER === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      model:       MODEL,
      apiKey:      process.env['ANTHROPIC_API_KEY'],
      temperature: 0.2,
      maxTokens:   8192,
    }) as unknown as BaseChatModel;
  }

  const { ChatOllama } = await import('@langchain/ollama');
  return new ChatOllama({
    model:       MODEL,
    baseUrl:     process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    temperature: 0.2,
    numCtx:      32768,  // qwen3.5 max — Ollama default is only 2048
    numPredict:  8192,
  }) as unknown as BaseChatModel;
}
