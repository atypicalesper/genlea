import 'dotenv-flow/config';
import { Job } from 'bullmq';
import {
  connectMongo, createWorker, QUEUE_NAMES,
  settingsRepository, logger,
} from '@genlea/shared';
import type { DiscoveryJobData } from '@genlea/shared';
import { runDiscoveryAgent } from './agents/discovery.agent.js';
import { startScheduler }   from './scheduler.js';

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
    const limit = Math.max(1, parseInt(process.env['ANTHROPIC_MAX_WORKER_CONCURRENCY'] ?? '1', 10));
    return Math.min(n, limit);
  }

  return provider === 'ollama' ? Math.min(n, 1) : n;
}

async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
  // The service process is just orchestration; discovery logic lives in the agent/tool layer.
  logger.info({ runId: job.data.runId, source: job.data.source }, '[discovery.worker] Delegating to agent');
  await runDiscoveryAgent(job.data);
}

async function bootstrap(): Promise<void> {
  await connectMongo();

  const initialSettings = await settingsRepository.get();
  const worker = createWorker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    processDiscoveryJob,
    cap(initialSettings.workerConcurrencyDiscovery),
  );
  logger.info({ concurrency: worker.concurrency }, '[discovery] Worker started');

  // Hot-reload concurrency from settings so operators can widen/narrow throughput live.
  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = cap(s.workerConcurrencyDiscovery);
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
