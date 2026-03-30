import 'dotenv-flow/config';
import { startDiscoveryWorker } from './discovery.worker.js';
import { startEnrichmentWorker } from './enrichment.worker.js';
import { startScoringWorker } from './scoring.worker.js';
import { startScheduler } from '../core/scheduler.js';
import { logger } from '../utils/logger.js';

async function main() {
  logger.info('[workers] Starting all GenLea workers...');
  await Promise.all([
    startDiscoveryWorker(),
    startEnrichmentWorker(),
    startScoringWorker(),
  ]);
  await startScheduler();
  logger.info('[workers] All workers running — scheduler active');
}

main().catch(err => {
  logger.error({ err }, '[workers] Fatal startup error');
  process.exit(1);
});
