import { traceable } from 'langsmith/traceable';
import { logger } from '../utils/logger.js';

// LangSmith auto-instruments all LangChain calls when LANGCHAIN_TRACING_V2=true.
// This module adds explicit span wrapping for non-LangChain code (agent loop steps).
// Tracing is hard-disabled for now because the LangSmith tenant is rate-limited.
const LANGSMITH_DISABLED = true;

let tracingSuppressed = false;
let quotaWarningSeen = false;
let patchInstalled = false;

const QUOTA_PATTERNS = [
  'Failed to send multipart request',
  'Monthly unique traces usage limit exceeded',
  'tenant exceeded usage limits',
];

const isEnabled = () =>
  !LANGSMITH_DISABLED &&
  !tracingSuppressed &&
  !!process.env['LANGCHAIN_API_KEY'] && process.env['LANGCHAIN_TRACING_V2'] === 'true';

function disableTracing(reason: string): void {
  if (tracingSuppressed) return;
  tracingSuppressed = true;
  process.env['LANGCHAIN_TRACING_V2'] = 'false';
  process.env['LANGSMITH_TRACING'] = 'false';
  process.env['LANGSMITH_TRACING_V2'] = 'false';
  process.env['LANGSMITH_TRACING_BACKGROUND'] = 'false';
  logger.warn({ reason }, '[langsmith] Tracing disabled for this process');
}

function installQuotaGuard(): void {
  if (patchInstalled) return;
  patchInstalled = true;

  const patchConsoleMethod = (method: 'warn' | 'error') => {
    const original = console[method].bind(console);
    console[method] = ((...args: unknown[]) => {
      const joined = args.map(arg => typeof arg === 'string' ? arg : String(arg)).join(' ');
      const isQuotaNoise = QUOTA_PATTERNS.some(pattern => joined.includes(pattern));
      if (!isQuotaNoise) {
        original(...args);
        return;
      }

      if (!quotaWarningSeen) {
        quotaWarningSeen = true;
        disableTracing('langsmith quota exceeded');
        original('[langsmith] Tracing quota exceeded; disabled tracing for this process.');
      }
    }) as typeof console[typeof method];
  };

  patchConsoleMethod('warn');
  patchConsoleMethod('error');
}

installQuotaGuard();

export function wrapTraceable<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => Promise<TReturn>,
  metadata?: Record<string, string>,
): (...args: TArgs) => Promise<TReturn> {
  if (!isEnabled()) return fn;

  return traceable(fn, {
    name,
    run_type: 'chain',
    ...metadata,
  }) as (...args: TArgs) => Promise<TReturn>;
}

export function wrapToolTraceable<TArgs extends unknown[], TReturn>(
  name: string,
  fn: (...args: TArgs) => Promise<TReturn>,
): (...args: TArgs) => Promise<TReturn> {
  if (!isEnabled()) return fn;

  return traceable(fn, {
    name,
    run_type: 'tool',
  }) as (...args: TArgs) => Promise<TReturn>;
}

// Called once at service startup to validate LangSmith config.
export function logLangSmithStatus(): void {
  if (LANGSMITH_DISABLED) {
    logger.info('[langsmith] Tracing hard-disabled in code');
  } else if (isEnabled()) {
    logger.info({
      project: process.env['LANGCHAIN_PROJECT'] ?? 'default',
      endpoint: process.env['LANGCHAIN_ENDPOINT'] ?? 'https://api.smith.langchain.com',
    }, '[langsmith] Tracing enabled');
  } else if (tracingSuppressed) {
    logger.warn('[langsmith] Tracing disabled after quota/rate-limit handling');
  } else {
    logger.debug('[langsmith] Tracing disabled — set LANGCHAIN_TRACING_V2=true + LANGCHAIN_API_KEY to enable');
  }
}
