import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { EnrichmentJobData } from '../types/index.js';
import { createWorker, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { runEnrichmentAgent } from '../agents/enrichment.agent.js';
import { logger } from '../utils/logger.js';

async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
  logger.info({ runId: job.data.runId, domain: job.data.domain }, '[enrichment.worker] Delegating to enrichment agent');
  await runEnrichmentAgent(job.data);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
export async function startEnrichmentWorker(): Promise<void> {
  await connectMongo();
  const initialSettings = await settingsRepository.get();
  const worker = createWorker<EnrichmentJobData>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    initialSettings.workerConcurrencyEnrichment,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyEnrichment }, '[enrichment.worker] Worker started (agent mode)');

  setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyEnrichment;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[enrichment.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[enrichment.worker] SIGTERM received — draining and shutting down');
    await worker.close();
    process.exit(0);
  });
}
