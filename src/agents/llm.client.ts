import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from '../utils/logger.js';

const PROVIDER = (process.env['AGENT_LLM_PROVIDER'] ?? 'ollama').toLowerCase();

const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-haiku-4-5-20251001',
};

export const MODEL = process.env['AGENT_LLM_MODEL'] ?? DEFAULT_MODELS[PROVIDER] ?? 'qwen3.5';

function is429(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; statusCode?: number };
  return e.status === 429 || e.statusCode === 429 || e.message.includes('429') || e.message.toLowerCase().includes('rate limit');
}

function withOllamaFallback(primary: BaseChatModel, fallback: BaseChatModel): BaseChatModel {
  return new Proxy(primary, {
    get(target, prop, receiver) {
      const val = Reflect.get(target, prop, receiver);
      if (prop !== 'invoke' || typeof val !== 'function') return val;
      return async function(...args: unknown[]) {
        try {
          return await (val as (...a: unknown[]) => Promise<unknown>).call(target, ...args);
        } catch (err) {
          if (!is429(err)) throw err;
          logger.warn('[llm] Groq 429 — falling back to Ollama');
          return await (fallback.invoke as (...a: unknown[]) => Promise<unknown>).call(fallback, ...args);
        }
      };
    },
  }) as unknown as BaseChatModel;
}

export async function buildLlm(): Promise<BaseChatModel> {
  logger.debug({ provider: PROVIDER, model: MODEL }, '[llm] Building LangChain model');

  if (PROVIDER === 'groq') {
    const [{ ChatGroq }, { ChatOllama }] = await Promise.all([
      import('@langchain/groq'),
      import('@langchain/ollama'),
    ]);
    const groqLlm = new ChatGroq({
      model:       MODEL,
      apiKey:      process.env['GROQ_API_KEY'],
      temperature: 0.2,
      maxTokens:   1024,
    }) as unknown as BaseChatModel;
    const ollamaLlm = new ChatOllama({
      model:       DEFAULT_MODELS['ollama'],
      baseUrl:     process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
      temperature: 0.2,
      numPredict:  1024,
    }) as unknown as BaseChatModel;
    return withOllamaFallback(groqLlm, ollamaLlm);
  }

  if (PROVIDER === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      model:       MODEL,
      apiKey:      process.env['ANTHROPIC_API_KEY'],
      temperature: 0.2,
      maxTokens:   1024,
    }) as unknown as BaseChatModel;
  }

  const { ChatOllama } = await import('@langchain/ollama');
  return new ChatOllama({
    model:       MODEL,
    baseUrl:     process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    temperature: 0.2,
    numPredict:  1024,
  }) as unknown as BaseChatModel;
}
