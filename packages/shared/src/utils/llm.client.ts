import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from './logger.js';

const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-haiku-4-5-20251001',
  google:    'gemini-2.0-flash',
};

function is429(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; statusCode?: number };
  return e.status === 429 || e.statusCode === 429 || e.message.includes('429') || e.message.toLowerCase().includes('rate limit');
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isTransientOllamaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('headers timeout') || message.includes('fetch failed') || message.includes('socket hang up');
}

function withTransientRetry(model: BaseChatModel): BaseChatModel {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'invoke' || typeof value !== 'function') return value;

      return async function(...args: unknown[]) {
        const maxAttempts = parseInt(process.env['OLLAMA_RETRY_ATTEMPTS'] ?? '3', 10);
        const retryDelayMs = parseInt(process.env['OLLAMA_RETRY_DELAY_MS'] ?? '1500', 10);

        let lastErr: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          try {
            return await (value as (...input: unknown[]) => Promise<unknown>).call(target, ...args);
          } catch (err) {
            lastErr = err;
            if (!isTransientOllamaError(err) || attempt === maxAttempts) throw err;
            logger.warn({ attempt, maxAttempts, err }, '[llm] Ollama transient failure — retrying');
            await sleep(retryDelayMs * attempt);
          }
        }

        throw lastErr;
      };
    },
  }) as unknown as BaseChatModel;
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
  const requestedProvider = (process.env['AGENT_LLM_PROVIDER'] ?? 'google').toLowerCase();
  const hostedEnabled = (process.env['ENABLE_HOSTED_LLM'] ?? 'false').toLowerCase() === 'true';
  const provider = !hostedEnabled && requestedProvider !== 'ollama' && requestedProvider !== 'google'
    ? 'ollama'
    : requestedProvider;
  const model = process.env['AGENT_LLM_MODEL'] ?? DEFAULT_MODELS[provider] ?? 'qwen3.5';

  if (!hostedEnabled && requestedProvider !== 'ollama') {
    logger.info({ requestedProvider }, '[llm] Hosted provider disabled — falling back to Ollama');
  }

  logger.debug({ provider, model }, '[llm] Building LangChain model');

  if (provider === 'groq') {
    const [{ ChatGroq }, { ChatOllama }] = await Promise.all([
      import('@langchain/groq'),
      import('@langchain/ollama'),
    ]);
    const groqLlm = new ChatGroq({
      model,
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
    return withTransientRetry(withOllamaFallback(groqLlm, ollamaLlm));
  }

  if (provider === 'anthropic') {
    const { ChatAnthropic } = await import('@langchain/anthropic');
    return new ChatAnthropic({
      model,
      apiKey:      process.env['ANTHROPIC_API_KEY'],
      temperature: 0.2,
      maxTokens:   8192,
    }) as unknown as BaseChatModel;
  }

  if (provider === 'google') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      model,
      apiKey:      process.env['GOOGLE_API_KEY'],
      temperature: 0.2,
      maxOutputTokens: 8192,
    }) as unknown as BaseChatModel;
  }

  const { ChatOllama } = await import('@langchain/ollama');
  const numCtx     = parseInt(process.env['OLLAMA_NUM_CTX']     ?? '32768', 10);
  const numPredict = parseInt(process.env['OLLAMA_NUM_PREDICT'] ?? '8192',  10);
  const ollama = new ChatOllama({
    model,
    baseUrl:    process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    temperature: 0.2,
    numCtx,
    numPredict,
    keepAlive:  '30m',
  }) as unknown as BaseChatModel;
  return withTransientRetry(ollama);
}
