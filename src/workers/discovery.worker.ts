import dotenvFlow from 'dotenv-flow';
dotenvFlow.config();
import { Job } from 'bullmq';
import { DiscoveryJobData } from '../types/index.js';
import { createWorker, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { runDiscoveryAgent } from '../agents/discovery.agent.js';
import { logger } from '../utils/logger.js';

function resolveProvider(): string {
  const requestedProvider = (process.env['AGENT_LLM_PROVIDER'] ?? 'google').toLowerCase();
  const hostedEnabled = (process.env['ENABLE_HOSTED_LLM'] ?? 'false').toLowerCase() === 'true';
  return !hostedEnabled && requestedProvider !== 'ollama' && requestedProvider !== 'google'
    ? 'ollama'
    : requestedProvider;
}

function cap(n: number): number {
  const provider = resolveProvider();

  if (provider === 'anthropic') {
    // Anthropic agent runs can loop through multiple tool iterations, so even a
    // small worker fan-out can overflow the input TPM budget. Keep a single lane
    // by default unless we explicitly widen it later.
    const limit = Math.max(1, parseInt(process.env['ANTHROPIC_MAX_WORKER_CONCURRENCY'] ?? '1', 10));
    return Math.min(n, limit);
  }

  return provider === 'ollama' ? Math.min(n, 1) : n;
}

async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
  // Keep worker logic thin so retries/restarts always execute the same agent entrypoint.
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
    cap(initialSettings.workerConcurrencyDiscovery),
  );
  logger.info({ concurrency: worker.concurrency }, '[discovery.worker] Worker started (agent mode)');

  // Poll settings so concurrency can be tuned without restarting the worker process.
  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = cap(s.workerConcurrencyDiscovery);
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
