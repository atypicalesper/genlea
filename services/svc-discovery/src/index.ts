import 'dotenv-flow/config';
import { Job } from 'bullmq';
import {
  connectMongo, createWorker, QUEUE_NAMES,
  settingsRepository, logger,
} from '@genlea/shared';
import type { DiscoveryJobData } from '@genlea/shared';
import { runDiscoveryAgent } from './agents/discovery.agent.js';
import { startScheduler }   from './scheduler.js';

async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
  logger.info({ runId: job.data.runId, source: job.data.source }, '[discovery.worker] Delegating to agent');
  await runDiscoveryAgent(job.data);
}

async function bootstrap(): Promise<void> {
  await connectMongo();

  const initialSettings = await settingsRepository.get();
  const worker = createWorker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    processDiscoveryJob,
    initialSettings.workerConcurrencyDiscovery,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyDiscovery }, '[discovery] Worker started');

  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyDiscovery;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[discovery] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  await startScheduler();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[discovery] Shutdown signal received');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
  logger.error({ err }, '[discovery] Fatal startup error');
  process.exit(1);
});
