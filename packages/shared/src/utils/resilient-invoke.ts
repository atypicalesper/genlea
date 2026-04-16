import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = parseInt(process.env['AGENT_TIMEOUT_MS'] ?? String(8 * 60 * 1000), 10);
const DEFAULT_MAX_RETRIES = 2;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type InvokeFn = (input: any, config: any) => Promise<any>;

/**
 * Wraps agent.invoke() with:
 * - Hard timeout (default 8 min, override via AGENT_TIMEOUT_MS)
 * - Exponential backoff retry on transient errors (connection reset, rate-limit, 502/503)
 *
 * Use in place of bare agent.invoke() in all worker-side agent calls.
 */
export async function resilientAgentInvoke(
  invoke:  InvokeFn,
  input:   unknown,
  config:  unknown,
  opts: {
    timeoutMs?:  number;
    maxRetries?: number;
    agentName?:  string;
  } = {},
): Promise<unknown> {
  const {
    timeoutMs  = DEFAULT_TIMEOUT_MS,
    maxRetries = DEFAULT_MAX_RETRIES,
    agentName  = 'agent',
  } = opts;

  let lastErr: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      const delayMs = Math.round(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
      logger.warn({ agentName, attempt, delayMs }, '[resilient-invoke] Retrying after error');
      await new Promise(r => setTimeout(r, delayMs));
    }

    try {
      let timeoutHandle: ReturnType<typeof setTimeout>;
      const timeoutSignal = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(
          () => reject(new Error(`[resilient-invoke] ${agentName} timed out after ${timeoutMs}ms`)),
          timeoutMs,
        );
      });

      try {
        const result = await Promise.race([invoke(input, config), timeoutSignal]);
        clearTimeout(timeoutHandle!);
        return result;
      } catch (raceErr) {
        clearTimeout(timeoutHandle!);
        throw raceErr;
      }
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        logger.error({ agentName, attempt, err: errMsg(err) }, '[resilient-invoke] Non-retryable error');
        break;
      }
      logger.warn({ agentName, attempt, err: errMsg(err) }, '[resilient-invoke] Retryable error');
    }
  }

  throw lastErr;
}

function isRetryable(err: unknown): boolean {
  const msg = errMsg(err).toLowerCase();
  return (
    msg.includes('econnreset')   ||
    msg.includes('econnrefused') ||
    msg.includes('etimedout')    ||
    msg.includes('timed out')    ||
    msg.includes('rate limit')   ||
    msg.includes('429')          ||
    msg.includes('503')          ||
    msg.includes('502')          ||
    msg.includes('socket hang up')
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
