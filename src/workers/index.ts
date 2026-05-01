import dotenvFlow from 'dotenv-flow';
dotenvFlow.config();
import { startDiscoveryWorker } from './discovery.worker.js';
import { startEnrichmentWorker } from './enrichment.worker.js';
import { startScoringWorker } from './scoring.worker.js';
import { startScheduler } from '../core/scheduler.js';
import { browserManager } from '../core/browser.manager.js';
import { logger } from '../utils/logger.js';

async function main() {
  logger.info('[workers] Starting all GenLea workers...');
  await Promise.all([
    startDiscoveryWorker(),
    startEnrichmentWorker(),
    startScoringWorker(),
  ]);
  await startScheduler();

  // Pre-warm browser pool so the first scraper job doesn't pay full launch cost.
  // BROWSER_WARMUP_COUNT=0 disables warmup for environments without scraping.
  const warmupCount = parseInt(process.env['BROWSER_WARMUP_COUNT'] ?? '1', 10);
  if (warmupCount > 0) {
    await browserManager.warmup(warmupCount);
  }

  // Heartbeat: surface zombie browsers periodically.
  const heartbeatMs = parseInt(process.env['BROWSER_HEARTBEAT_MS'] ?? '300000', 10);
  const heartbeat = browserManager.startHeartbeat(heartbeatMs);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[workers] Shutdown signal — closing browsers');
    clearInterval(heartbeat);
    await browserManager.closeAll().catch(err => logger.warn({ err }, '[workers] Browser closeAll failed'));
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT',  () => void shutdown('SIGINT'));

  logger.info('[workers] All workers running — scheduler active');
}

main().catch(err => {
  logger.error({ err }, '[workers] Fatal startup error');
  process.exit(1);
});
