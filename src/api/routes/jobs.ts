import { FastifyInstance } from 'fastify';
import { queueManager, discoveryQueue, enrichmentQueue, scoringQueue } from '../../core/queue.manager.js';
import { scrapeLogRepository } from '../../storage/repositories/scrape-log.repository.js';
import { getLastSeedAt, getSeedQueryCount } from '../../core/scheduler.js';
import { logger } from '../../utils/logger.js';

export async function jobsRoutes(app: FastifyInstance) {

  // GET /api/jobs/status — live queue counts
  app.get('/jobs/status', async (_req, reply) => {
    logger.debug('[api:jobs] GET /jobs/status request');
    const stats = await queueManager.getQueueStats();
    return reply.send({ success: true, data: stats });
  });

  // GET /api/jobs/active — what is currently being processed
  app.get('/jobs/active', async (_req, reply) => {
    const active = await queueManager.getActiveJobs();
    return reply.send({ success: true, data: active });
  });

  // GET /api/jobs/logs — recent scrape logs
  app.get<{ Querystring: { scraper?: string; limit?: string } }>(
    '/jobs/logs',
    async (req, reply) => {
      const { scraper, limit } = req.query;
      logger.info({ scraper, limit }, '[api:jobs] GET /jobs/logs request');
      const logs = await scrapeLogRepository.findRecent(
        scraper as any,
        parseInt(limit ?? '50')
      );
      return reply.send({ success: true, data: logs });
    }
  );

  // GET /api/jobs/stats — success/fail counts
  app.get('/jobs/stats', async (_req, reply) => {
    const stats = await scrapeLogRepository.getStats();
    return reply.send({ success: true, data: stats });
  });

  // GET /api/jobs/cron — cron schedule info
  app.get('/jobs/cron', async (_req, reply) => {
    const nowMs = Date.now();
    // Next 2h boundary
    const twoHourMs = 2 * 60 * 60 * 1000;
    const nextRunMs = Math.ceil(nowMs / twoHourMs) * twoHourMs;
    return reply.send({
      success: true,
      data: {
        schedule: '0 */2 * * *',
        description: 'Every 2 hours (on the hour)',
        lastSeedAt: getLastSeedAt()?.toISOString() ?? null,
        nextApproxAt: new Date(nextRunMs).toISOString(),
        seedQueryCount: getSeedQueryCount(),
      },
    });
  });

  // DELETE /api/jobs/clear/:queue — drain a queue (for dev/reset)
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
    return reply.send({ success: true, data: { queue, message: 'Queue drained (waiting jobs removed)' } });
  });
}
