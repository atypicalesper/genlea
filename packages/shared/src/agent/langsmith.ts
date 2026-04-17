import { traceable } from 'langsmith/traceable';
import { logger } from '../utils/logger.js';

// LangSmith auto-instruments all LangChain calls when LANGCHAIN_TRACING_V2=true.
// This module adds explicit span wrapping for non-LangChain code (agent loop steps).

const isEnabled = () =>
  !!process.env['LANGCHAIN_API_KEY'] && process.env['LANGCHAIN_TRACING_V2'] === 'true';

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
  if (isEnabled()) {
    logger.info({
      project: process.env['LANGCHAIN_PROJECT'] ?? 'default',
      endpoint: process.env['LANGCHAIN_ENDPOINT'] ?? 'https://api.smith.langchain.com',
    }, '[langsmith] Tracing enabled');
  } else {
    logger.debug('[langsmith] Tracing disabled — set LANGCHAIN_TRACING_V2=true + LANGCHAIN_API_KEY to enable');
  }
}
