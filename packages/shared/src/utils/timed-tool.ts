import { logger } from './logger.js';

/**
 * Wraps a LangChain tool function with latency logging and embeds `_latencyMs`
 * into its JSON response so the agent step parser can surface it in scrape logs.
 *
 * Usage:
 *   tool(withTiming('my_tool', async (args) => { ... }), { name: 'my_tool', schema })
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withTiming(
  name: string,
  fn:   (args: any) => Promise<string>,
): (args: any) => Promise<string> {
  return async (args: any): Promise<string> => {
    const start = Date.now();
    try {
      const result    = await fn(args);
      const latencyMs = Date.now() - start;
      logger.debug({ tool: name, latencyMs }, '[tool-timing] completed');

      // Embed latency into JSON responses — the agent step parser reads `_latencyMs`
      try {
        const parsed = JSON.parse(result) as Record<string, unknown>;
        return JSON.stringify({ ...parsed, _latencyMs: latencyMs });
      } catch {
        return result;  // non-JSON tool output — return as-is
      }
    } catch (err) {
      logger.error({ tool: name, latencyMs: Date.now() - start, err }, '[tool-timing] failed');
      throw err;
    }
  };
}
