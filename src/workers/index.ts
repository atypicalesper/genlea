import 'dotenv-flow/config';
import { startDiscoveryWorker } from './discovery.worker.js';
import { startEnrichmentWorker } from './enrichment.worker.js';
import { startScoringWorker } from './scoring.worker.js';
import { logger } from '../utils/logger.js';

async function main() {
  logger.info('[workers] Starting all GenLea workers...');
  await Promise.all([
    startDiscoveryWorker(),
    startEnrichmentWorker(),
    startScoringWorker(),
  ]);
  logger.info('[workers] All workers running — waiting for jobs');
}

main().catch(err => {
  logger.error({ err }, '[workers] Fatal startup error');
  process.exit(1);
});
