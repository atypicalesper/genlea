import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from '../utils/logger.js';

const REQUESTED_PROVIDER = (process.env['AGENT_LLM_PROVIDER'] ?? 'ollama').toLowerCase();
const HOSTED_MODELS_ENABLED = (process.env['ENABLE_HOSTED_LLM'] ?? 'false').toLowerCase() === 'true';
const PROVIDER = !HOSTED_MODELS_ENABLED && REQUESTED_PROVIDER !== 'ollama'
  ? 'ollama'
  : REQUESTED_PROVIDER;

const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-haiku-4-5-20251001',
  google:    'gemini-2.0-flash',
};

export const MODEL = process.env['AGENT_LLM_MODEL'] ?? DEFAULT_MODELS[PROVIDER] ?? 'qwen3.5';

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

export async function buildLlm(): Promise<BaseChatModel> {
  if (!HOSTED_MODELS_ENABLED && REQUESTED_PROVIDER !== 'ollama') {
    // Keep hosted-provider wiring in the codebase for later, but default the MVP to the free local path.
    logger.info({ requestedProvider: REQUESTED_PROVIDER }, '[llm] Hosted provider disabled — falling back to Ollama');
  }

  logger.debug({ provider: PROVIDER, model: MODEL }, '[llm] Building LangChain model');

  if (PROVIDER === 'groq') {
    const { ChatGroq } = await import('@langchain/groq');
    return new ChatGroq({
      model:       MODEL,
      apiKey:      process.env['GROQ_API_KEY'],
      temperature: 0.2,
      maxTokens:   1024,
    }) as unknown as BaseChatModel;
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

  if (PROVIDER === 'google') {
    const { ChatGoogleGenerativeAI } = await import('@langchain/google-genai');
    return new ChatGoogleGenerativeAI({
      model:       MODEL,
      apiKey:      process.env['GOOGLE_API_KEY'],
      temperature: 0.2,
      maxOutputTokens: 1024,
    }) as unknown as BaseChatModel;
  }

  const { ChatOllama } = await import('@langchain/ollama');
  const ollama = new ChatOllama({
    model:       MODEL,
    baseUrl:     process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434',
    temperature: 0.2,
    numPredict:  parseInt(process.env['OLLAMA_NUM_PREDICT'] ?? '1024', 10),
    numCtx:      parseInt(process.env['OLLAMA_NUM_CTX'] ?? '8192', 10),
    keepAlive:   process.env['OLLAMA_KEEP_ALIVE'] ?? '30m',
  }) as unknown as BaseChatModel;
  return withTransientRetry(ollama);
}
