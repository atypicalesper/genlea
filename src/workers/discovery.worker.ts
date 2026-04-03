import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { DiscoveryJobData } from '../types/index.js';
import { createWorker, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { runDiscoveryAgent } from '../agents/discovery.agent.js';
import { logger } from '../utils/logger.js';

async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
  logger.info({ runId: job.data.runId, source: job.data.source }, '[discovery.worker] Delegating to discovery agent');
  await runDiscoveryAgent(job.data);
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
export async function startDiscoveryWorker(): Promise<void> {
  await connectMongo();
  const initialSettings = await settingsRepository.get();
  const worker = createWorker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    processDiscoveryJob,
    initialSettings.workerConcurrencyDiscovery,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyDiscovery }, '[discovery.worker] Worker started (agent mode)');

  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyDiscovery;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[discovery.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[discovery.worker] SIGTERM received — shutting down');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  });
}
