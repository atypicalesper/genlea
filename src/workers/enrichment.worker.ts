import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { EnrichmentJobData } from '../types/index.js';
import { createWorker, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { runEnrichmentAgent } from '../agents/enrichment.agent.js';
import { logger } from '../utils/logger.js';

function cap(n: number): number {
  return process.env['AGENT_LLM_PROVIDER'] === 'ollama' ? Math.min(n, 1) : n;
}

async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
  // The enrichment agent owns source selection and stopping conditions for each company.
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
    cap(initialSettings.workerConcurrencyEnrichment),
  );
  logger.info({ concurrency: worker.concurrency }, '[enrichment.worker] Worker started (agent mode)');

  // Keep worker concurrency aligned with DB-backed settings during long-running sessions.
  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = cap(s.workerConcurrencyEnrichment);
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[enrichment.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[enrichment.worker] SIGTERM received — draining and shutting down');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  });
}
