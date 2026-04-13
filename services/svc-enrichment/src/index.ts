import 'dotenv-flow/config';
import { Job } from 'bullmq';
import {
  connectMongo, createWorker, QUEUE_NAMES,
  settingsRepository, logger,
} from '@genlea/shared';
import type { EnrichmentJobData } from '@genlea/shared';
import { runEnrichmentAgent } from './agents/enrichment.agent.js';

async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
  logger.info({ runId: job.data.runId, domain: job.data.domain }, '[enrichment.worker] Delegating to agent');
  await runEnrichmentAgent(job.data);
}

async function bootstrap(): Promise<void> {
  await connectMongo();

  const initialSettings = await settingsRepository.get();
  const worker = createWorker<EnrichmentJobData>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    initialSettings.workerConcurrencyEnrichment,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyEnrichment }, '[enrichment] Worker started');

  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyEnrichment;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[enrichment] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[enrichment] Shutdown signal received');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
  logger.error({ err }, '[enrichment] Fatal startup error');
  process.exit(1);
});
