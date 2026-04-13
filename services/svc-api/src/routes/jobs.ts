import { FastifyInstance } from 'fastify';
import {
  queueManager,
  discoveryQueue,
  enrichmentQueue,
  scoringQueue,
  scrapeLogRepository,
  companyRepository,
  getSeedQueryCount,
  generateRunId,
  logger,
} from '@genlea/shared';

export async function jobsRoutes(app: FastifyInstance) {

  app.get('/jobs/status', async (_req, reply) => {
    const stats = await queueManager.getQueueStats();
    return reply.send({ success: true, data: stats });
  });

  app.post('/jobs/rescore-all', async (_req, reply) => {
    const runId = generateRunId();
    logger.info({ runId }, '[api:jobs] Rescore-all requested');

    const companies = await companyRepository.findMany({}, { projection: { _id: 1 } as any });
    await Promise.all(
      companies.map(c => queueManager.addScoringJob({ runId, companyId: c._id! }))
    );

    logger.info({ runId, queued: companies.length }, '[api:jobs] Rescore-all queued');
    return reply.status(202).send({
      success: true,
      data: { runId, queued: companies.length, message: `${companies.length} scoring jobs queued` },
    });
  });

  app.get('/jobs/active', async (_req, reply) => {
    const active = await queueManager.getActiveJobs();
    return reply.send({ success: true, data: active });
  });

  app.get<{ Querystring: { scraper?: string; limit?: string } }>(
    '/jobs/logs',
    async (req, reply) => {
      const { scraper, limit } = req.query;
      const logs = await scrapeLogRepository.findRecent(scraper as any, parseInt(limit ?? '50'));
      return reply.send({ success: true, data: logs });
    }
  );

  app.get('/jobs/stats', async (_req, reply) => {
    const stats = await scrapeLogRepository.getStats();
    return reply.send({ success: true, data: stats });
  });

  app.get('/jobs/cron', async (_req, reply) => {
    const nowMs = Date.now();
    const twoHourMs = 2 * 60 * 60 * 1000;
    const nextRunMs = Math.ceil(nowMs / twoHourMs) * twoHourMs;
    return reply.send({
      success: true,
      data: {
        schedule:       '0 */2 * * *',
        description:    'Every 2 hours (on the hour)',
        nextApproxAt:   new Date(nextRunMs).toISOString(),
        seedQueryCount: getSeedQueryCount(),
      },
    });
  });

  app.post<{ Params: { queue: string } }>('/jobs/retry/:queue', async (req, reply) => {
    const { queue } = req.params;
    const validQueues = ['discovery', 'enrichment', 'scoring'] as const;
    if (!validQueues.includes(queue as any)) {
      return reply.status(400).send({ success: false, error: 'Invalid queue. Valid: discovery, enrichment, scoring' });
    }
    const retried = await queueManager.retryFailed(queue as 'discovery' | 'enrichment' | 'scoring');
    return reply.send({ success: true, data: { queue, retried, message: `${retried} failed jobs re-queued` } });
  });

  app.delete<{ Params: { queue: string } }>('/jobs/clear/:queue', async (req, reply) => {
    const { queue } = req.params;
    const queueMap: Record<string, { drain: () => Promise<void> }> = {
      discovery:  discoveryQueue,
      enrichment: enrichmentQueue,
      scoring:    scoringQueue,
    };
    if (!queueMap[queue]) {
      return reply.status(400).send({ success: false, error: 'Invalid queue. Valid: discovery, enrichment, scoring' });
    }
    logger.warn({ queue }, '[api:jobs] Queue drain requested');
    await queueMap[queue].drain();
    return reply.send({ success: true, data: { queue, message: 'Queue drained' } });
  });
}
