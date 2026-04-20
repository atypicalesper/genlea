import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from './logger.js';

const PROVIDER = (process.env['AGENT_LLM_PROVIDER'] ?? 'ollama').toLowerCase();

const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-3-5-haiku-20241022',
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
      maxTokens:   8192,
    }) as unknown as BaseChatModel;
    const numCtx     = parseInt(process.env['OLLAMA_NUM_CTX']     ?? '32768', 10);
    const numPredict = parseInt(process.env['OLLAMA_NUM_PREDICT'] ?? '8192',  10);
    const ollamaLlm = new ChatOllama({
      model:       DEFAULT_MODELS['ollama'],
      baseUrl:     process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
      temperature: 0.2,
      numCtx,
      numPredict,
      keepAlive:   '30m',
    }) as unknown as BaseChatModel;
    return withOllamaFallback(groqLlm, ollamaLlm);
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
