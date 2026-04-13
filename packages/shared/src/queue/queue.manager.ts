import { Queue, Worker, Job, ConnectionOptions } from 'bullmq';
import {
  DiscoveryJobData,
  EnrichmentJobData,
  ScoringJobData,
} from '../types/index.js';
import { logger } from '../utils/logger.js';

const connection: ConnectionOptions = {
  url:      process.env['REDIS_URL'] ?? 'redis://localhost:6379',
  password: process.env['REDIS_PASSWORD'] || undefined,
};

export const QUEUE_NAMES = {
  DISCOVERY:  'genlea-discovery',
  ENRICHMENT: 'genlea-enrichment',
  SCORING:    'genlea-scoring',
} as const;

const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500 },
};

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

export class QueueManager {
  async addDiscoveryJob(data: DiscoveryJobData): Promise<void> {
    await discoveryQueue.add(`discovery:${data.source}:${data.runId}`, data);
    logger.debug({ runId: data.runId, source: data.source }, 'Discovery job queued');
  }

  async addEnrichmentJob(data: EnrichmentJobData): Promise<void> {
    // Use companyId as jobId so concurrent discovery jobs for the same company
    // collapse into one enrichment job rather than queuing duplicates.
    await enrichmentQueue.add(`enrich:${data.domain}:${data.runId}`, data, {
      jobId: `enrich:${data.companyId}`,
    });
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
    return { discovery: discoveryCounts, enrichment: enrichmentCounts, scoring: scoringCounts };
  }

  async getActiveJobs(): Promise<Array<{
    queue: string;
    jobId: string | undefined;
    name: string;
    source?: string;
    domain?: string;
    companyId?: string;
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
        return { queue, jobId: j.id, name: j.name, source: parts[1], runId: parts[2], startedAt };
      }
      if (queue === 'enrichment') {
        const d = j.data as EnrichmentJobData;
        return { queue, jobId: j.id, name: j.name, domain: parts[1], companyId: d.companyId, runId: parts[2], startedAt };
      }
      const d = j.data as ScoringJobData;
      return { queue, jobId: j.id, name: j.name, companyId: d.companyId ?? parts[1], runId: parts[2], startedAt };
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
    logger.info({ jobId: job.id, queue: queueName, name: job.name }, '[worker] Job completed');
  });

  worker.on('failed', (job, err) => {
    const errMsg   = err instanceof Error ? err.message : String(err);
    const errCause = (err as any)?.cause ? String((err as any).cause) : undefined;
    const errCode  = (err as any)?.code;
    logger.error(
      {
        jobId:   job?.id,
        jobName: job?.name,
        queue:   queueName,
        attempt: job?.attemptsMade,
        data:    job?.data,
        error:   errMsg,
        cause:   errCause,
        code:    errCode,
        stack:   err instanceof Error ? err.stack : undefined,
      },
      '[worker] Job failed',
    );
  });

  worker.on('stalled', jobId => {
    logger.warn({ jobId, queue: queueName }, '[worker] Job stalled — will be retried');
  });

  worker.on('error', err => {
    logger.error(
      { queue: queueName, error: err.message, stack: err.stack },
      '[worker] Worker-level error (Redis/connection issue)',
    );
  });

  return worker;
}
