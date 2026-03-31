import { Queue, Worker, QueueEvents, Job, ConnectionOptions } from 'bullmq';
import {
  DiscoveryJobData,
  EnrichmentJobData,
  ScoringJobData,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const connection: ConnectionOptions = {
  url: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  password: process.env['REDIS_PASSWORD'] || undefined,
};

// ── Queue Names ───────────────────────────────────────────────────────────────
export const QUEUE_NAMES = {
  DISCOVERY: 'genlea-discovery',
  ENRICHMENT: 'genlea-enrichment',
  SCORING: 'genlea-scoring',
} as const;

// ── Queue Defaults ────────────────────────────────────────────────────────────
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

// ── Queues ────────────────────────────────────────────────────────────────────
export const discoveryQueue = new Queue<DiscoveryJobData>(QUEUE_NAMES.DISCOVERY, {
  connection,
  defaultJobOptions,
});

export const enrichmentQueue = new Queue<EnrichmentJobData>(QUEUE_NAMES.ENRICHMENT, {
  connection,
  defaultJobOptions,
});

export const scoringQueue = new Queue<ScoringJobData>(QUEUE_NAMES.SCORING, {
  connection,
  defaultJobOptions,
});

// ── Queue Manager ─────────────────────────────────────────────────────────────
export class QueueManager {
  async addDiscoveryJob(data: DiscoveryJobData): Promise<void> {
    await discoveryQueue.add(`discovery:${data.source}:${data.runId}`, data);
    logger.debug({ runId: data.runId, source: data.source }, 'Discovery job queued');
  }

  async addEnrichmentJob(data: EnrichmentJobData): Promise<void> {
    await enrichmentQueue.add(`enrich:${data.domain}:${data.runId}`, data);
    logger.debug({ runId: data.runId, domain: data.domain }, 'Enrichment job queued');
  }

  async addScoringJob(data: ScoringJobData): Promise<void> {
    await scoringQueue.add(`score:${data.companyId}:${data.runId}`, data);
    logger.debug({ runId: data.runId, companyId: data.companyId }, 'Scoring job queued');
  }

  async getQueueStats() {
    const [discoveryCounts, enrichmentCounts, scoringCounts] = await Promise.all([
      discoveryQueue.getJobCounts(),
      enrichmentQueue.getJobCounts(),
      scoringQueue.getJobCounts(),
    ]);

    return {
      discovery: discoveryCounts,
      enrichment: enrichmentCounts,
      scoring: scoringCounts,
    };
  }

  async getActiveJobs(): Promise<Array<{
    queue: string;
    jobId: string | undefined;
    name: string;
    source?: string;
    domain?: string;
    runId?: string;
    startedAt: Date | null;
  }>> {
    const [discoveryActive, enrichmentActive, scoringActive] = await Promise.all([
      discoveryQueue.getActive(),
      enrichmentQueue.getActive(),
      scoringQueue.getActive(),
    ]);

    const parse = (jobs: Job[], queue: string) => jobs.map(j => {
      const parts = j.name.split(':');
      const startedAt = j.processedOn ? new Date(j.processedOn) : null;

      if (queue === 'discovery') {
        // name format: "${label}:${source}:${runId}"
        return { queue, jobId: j.id, name: j.name, source: parts[1], runId: parts[2], startedAt };
      }
      if (queue === 'enrichment') {
        // name format: "enrich:${domain}:${runId}"
        return { queue, jobId: j.id, name: j.name, domain: parts[1], runId: parts[2], startedAt };
      }
      // scoring: "score:${companyId}:${runId}"
      return { queue, jobId: j.id, name: j.name, runId: parts[2], startedAt };
    });

    return [
      ...parse(discoveryActive, 'discovery'),
      ...parse(enrichmentActive, 'enrichment'),
      ...parse(scoringActive, 'scoring'),
    ];
  }

  async retryFailed(queueName: 'discovery' | 'enrichment' | 'scoring'): Promise<number> {
    const queueMap = {
      discovery:  discoveryQueue,
      enrichment: enrichmentQueue,
      scoring:    scoringQueue,
    };
    const queue = queueMap[queueName];
    const failedJobs = await queue.getFailed();
    await Promise.all(failedJobs.map(j => j.retry()));
    logger.info({ queue: queueName, retried: failedJobs.length }, 'Failed jobs retried');
    return failedJobs.length;
  }

  async drainAll(): Promise<void> {
    await Promise.all([
      discoveryQueue.drain(),
      enrichmentQueue.drain(),
      scoringQueue.drain(),
    ]);
    logger.info('All queues drained');
  }

  async closeAll(): Promise<void> {
    await Promise.all([
      discoveryQueue.close(),
      enrichmentQueue.close(),
      scoringQueue.close(),
    ]);
    logger.info('All queues closed');
  }
}

export const queueManager = new QueueManager();

// ── Helper: Create a typed Worker ─────────────────────────────────────────────
export function createWorker<T>(
  queueName: string,
  processor: (job: Job<T>) => Promise<void>,
  concurrency: number = 2
): Worker<T> {
  const worker = new Worker<T>(queueName, processor, {
    connection,
    concurrency,
  });

  worker.on('completed', job => {
    logger.info({ jobId: job.id, queue: queueName }, 'Job completed');
  });

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, queue: queueName, err }, 'Job failed');
  });

  worker.on('stalled', jobId => {
    logger.warn({ jobId, queue: queueName }, 'Job stalled');
  });

  return worker;
}
