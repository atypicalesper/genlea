import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { logger } from './logger.js';

// Shared services default Anthropic to Sonnet so prompt caching has a real chance
// to pay off on the repeated agent prefix.
const DEFAULT_MODELS: Record<string, string> = {
  ollama:    'qwen3.5',
  groq:      'llama-3.3-70b-versatile',
  anthropic: 'claude-sonnet-4-6',
  google:    'gemini-2.0-flash',
};

export const MODEL = process.env['AGENT_LLM_MODEL']
  ?? DEFAULT_MODELS[(process.env['AGENT_LLM_PROVIDER'] ?? 'google').toLowerCase()]
  ?? 'qwen3.5';

type LlmInvokeOptions = {
  cache_control?: { type: 'ephemeral' };
};

type AnthropicTokenReservation = {
  startedAt: number;
  tokens: number;
};

let anthropicLimiterActive = 0;
let anthropicLimiterLastStartedAt = 0;
let anthropicLimiterQueue: Promise<void> = Promise.resolve();
let anthropicTokenReservations: AnthropicTokenReservation[] = [];


function is429(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const e = err as Error & { status?: number; statusCode?: number };
  return e.status === 429 || e.statusCode === 429 || e.message.includes('429') || e.message.toLowerCase().includes('rate limit');
}


function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeSerialize(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value ?? '');
  }
}

function pruneAnthropicReservations(now: number): void {
  anthropicTokenReservations = anthropicTokenReservations.filter(entry => now - entry.startedAt < 60_000);
}

function estimateAnthropicInputTokens(args: unknown[]): number {
  // Stay conservative: Anthropic limits are on input TPM, so a mild overestimate
  // is safer than trying to squeeze every last request into the minute window.
  const serialized = args.map(arg => safeSerialize(arg)).join('\n');
  return Math.max(512, Math.ceil(serialized.length / 3));
}

function getAnthropicInputTokenLimit(): number {
  return Math.max(1_000, parseInt(process.env['ANTHROPIC_MAX_INPUT_TOKENS_PER_MIN'] ?? '24000', 10));
}

function getAnthropicRetryDelayMs(): number {
  return Math.max(1_000, parseInt(process.env['ANTHROPIC_RATE_LIMIT_RETRY_MS'] ?? '10_000', 10));
}

function getAnthropicConcurrencyLimit(): number {
  return Math.max(1, parseInt(process.env['ANTHROPIC_MAX_CONCURRENT_REQUESTS'] ?? '1', 10));
}

function getAnthropicMinIntervalMs(): number {
  return Math.max(0, parseInt(process.env['ANTHROPIC_MIN_REQUEST_INTERVAL_MS'] ?? '2500', 10));
}


function resolveProvider(): string {
  const requestedProvider = (process.env['AGENT_LLM_PROVIDER'] ?? 'google').toLowerCase();
  const hostedEnabled = (process.env['ENABLE_HOSTED_LLM'] ?? 'false').toLowerCase() === 'true';
  return !hostedEnabled && requestedProvider !== 'ollama' && requestedProvider !== 'google'
    ? 'ollama'
    : requestedProvider;
}


async function runWithAnthropicRateLimit<T>(estimatedInputTokens: number, fn: () => Promise<T>): Promise<T> {
  const maxConcurrent = getAnthropicConcurrencyLimit();
  const minIntervalMs = getAnthropicMinIntervalMs();
  const inputTokenLimit = getAnthropicInputTokenLimit();

  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });

  const turn = anthropicLimiterQueue.then(async () => {
    while (true) {
      const now = Date.now();
      pruneAnthropicReservations(now);

      const usedTokens = anthropicTokenReservations.reduce((sum, entry) => sum + entry.tokens, 0);
      const intervalWaitMs = Math.max(0, anthropicLimiterLastStartedAt + minIntervalMs - now);
      const tokenWaitMs = anthropicTokenReservations.length > 0 && usedTokens + estimatedInputTokens > inputTokenLimit
        ? Math.max(250, 60_000 - (now - anthropicTokenReservations[0]!.startedAt))
        : 0;

      if (anthropicLimiterActive < maxConcurrent && intervalWaitMs === 0 && tokenWaitMs === 0) {
        anthropicLimiterActive += 1;
        anthropicLimiterLastStartedAt = now;
        anthropicTokenReservations.push({ startedAt: now, tokens: estimatedInputTokens });
        break;
      }

      await sleep(Math.max(intervalWaitMs, tokenWaitMs, 100));
    }
  });

  anthropicLimiterQueue = turn.then(() => gate);

  await turn;

  try {
    const maxAttempts = Math.max(1, parseInt(process.env['ANTHROPIC_RATE_LIMIT_RETRY_ATTEMPTS'] ?? '2', 10));
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (err) {
        if (!is429(err) || attempt === maxAttempts) throw err;
        const retryDelayMs = getAnthropicRetryDelayMs() * attempt;
        logger.warn({ attempt, retryDelayMs }, '[llm] Anthropic rate limited — backing off before retry');
        await sleep(retryDelayMs);
      }
    }

    throw new Error('Anthropic retry loop exited unexpectedly');
  } finally {
    anthropicLimiterActive = Math.max(0, anthropicLimiterActive - 1);
    release();
  }
}


function isTransientOllamaError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const message = err.message.toLowerCase();
  return message.includes('headers timeout') || message.includes('fetch failed') || message.includes('socket hang up');
}


// Local-model failures are often transient; retries are cheaper than dropping the job.
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


// Groq is fast but can rate-limit; use the local Ollama path as a safety net.
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


function withAnthropicRateLimit(model: BaseChatModel): BaseChatModel {
  return new Proxy(model, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (prop !== 'invoke' || typeof value !== 'function') return value;

      return async function(...args: unknown[]) {
        const estimatedInputTokens = estimateAnthropicInputTokens(args);
        return runWithAnthropicRateLimit(estimatedInputTokens, () =>
          (value as (...input: unknown[]) => Promise<unknown>).call(target, ...args),
        );
      };
    },
  }) as unknown as BaseChatModel;
}


export async function buildLlm(): Promise<BaseChatModel> {
  const requestedProvider = (process.env['AGENT_LLM_PROVIDER'] ?? 'google').toLowerCase();
  const hostedEnabled = (process.env['ENABLE_HOSTED_LLM'] ?? 'false').toLowerCase() === 'true';
  const provider = resolveProvider();
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
    const anthropic = new ChatAnthropic({
      model,
      apiKey:      process.env['ANTHROPIC_API_KEY'],
      temperature: 0.2,
      maxTokens:   8192,
    }) as unknown as BaseChatModel;
    return withAnthropicRateLimit(anthropic);
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

export function buildLlmInvokeOptions(): LlmInvokeOptions {
  const provider = resolveProvider();
  const promptCachingEnabled = (process.env['ANTHROPIC_PROMPT_CACHING'] ?? 'true').toLowerCase() === 'true';

  if (provider === 'anthropic' && promptCachingEnabled) {
    // Attach cache_control only when Anthropic is active and the model is expensive
    // enough for prompt caching to be worth the extra write cost. Keep the
    // behavior model-agnostic so Haiku/Sonnet/Opus all share the same invoke path.
    return { cache_control: { type: 'ephemeral' } };
  }

  return {};
}
