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
  // numCtx: Ollama default is 2048 — qwen3.5 supports 32768 (fits fine on 18GB M3 Pro).
  // Override via OLLAMA_NUM_CTX if you need to reduce for a larger model.
  const numCtx     = parseInt(process.env['OLLAMA_NUM_CTX']     ?? '32768', 10);
  const numPredict = parseInt(process.env['OLLAMA_NUM_PREDICT'] ?? '8192',  10);
  return new ChatOllama({
    model:      MODEL,
    baseUrl:    process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    temperature: 0.2,
    numCtx,
    numPredict,
    keepAlive:  '30m',  // keep model loaded between agent runs — avoids ~3s cold-start per job
  }) as unknown as BaseChatModel;
}
