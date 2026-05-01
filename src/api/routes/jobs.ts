import { FastifyInstance } from 'fastify';
import { queueManager, discoveryQueue, enrichmentQueue, scoringQueue } from '../../core/queue.manager.js';
import { scrapeLogRepository } from '../../storage/repositories/scrape-log.repository.js';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { getLastSeedAt, getSeedQueryCount } from '../../core/scheduler.js';
import { generateRunId } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';
import { jobLogsQuerySchema, queueParamSchema, parseQuery, parseParams } from '../schemas.js';

export async function jobsRoutes(app: FastifyInstance) {

  // GET /api/jobs/status — live queue counts
  app.get('/jobs/status', async (_req, reply) => {
    logger.debug('[api:jobs] GET /jobs/status request');
    const stats = await queueManager.getQueueStats();
    return reply.send({ success: true, data: stats });
  });

  // POST /api/jobs/rescore-all — queue a scoring job for every company in the DB
  app.post('/jobs/rescore-all', async (req, reply) => {
    const runId = generateRunId();
    logger.info({ runId, correlationId: req.correlationId }, '[api:jobs] Rescore-all requested');

    const companies = await companyRepository.findMany({}, { projection: { _id: 1 } as any });
    await Promise.all(
      companies.map(c => queueManager.addScoringJob({ runId, companyId: c._id!, correlationId: req.correlationId }))
    );

    logger.info({ runId, queued: companies.length, correlationId: req.correlationId }, '[api:jobs] Rescore-all queued');
    return reply.status(202).send({
      success: true,
      data: { runId, queued: companies.length, message: `${companies.length} scoring jobs queued` },
    });
  });

  // GET /api/jobs/active — what is currently being processed
  app.get('/jobs/active', async (_req, reply) => {
    const active = await queueManager.getActiveJobs();
    const visible = await Promise.all(active.map(async job => {
      if (!job.companyId) return job;
      const company = await companyRepository.findById(job.companyId);
      return company?.status === 'disqualified' && company.manuallyReviewed ? null : job;
    }));
    return reply.send({ success: true, data: visible.filter(Boolean) });
  });

  // GET /api/jobs/logs — recent scrape logs
  app.get('/jobs/logs', async (req, reply) => {
    const q = parseQuery(jobLogsQuerySchema, req, reply);
    if (!q) return;
    const { scraper, limit } = q;
    logger.info({ scraper, limit, correlationId: req.correlationId }, '[api:jobs] GET /jobs/logs request');
    const logs = await scrapeLogRepository.findRecent(scraper as any, limit ?? 50);
    return reply.send({ success: true, data: logs });
  });

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

  // POST /api/jobs/retry/:queue — retry all failed jobs in a queue
  app.post('/jobs/retry/:queue', async (req, reply) => {
    const params = parseParams(queueParamSchema, req, reply);
    if (!params) return;
    const { queue } = params;
    logger.info({ queue, correlationId: req.correlationId }, '[api:jobs] Retry failed jobs requested');
    const retried = await queueManager.retryFailed(queue);
    return reply.send({ success: true, data: { queue, retried, message: `${retried} failed jobs re-queued` } });
  });

  // DELETE /api/jobs/clear/:queue — drain a queue (for dev/reset)
  app.delete('/jobs/clear/:queue', async (req, reply) => {
    const params = parseParams(queueParamSchema, req, reply);
    if (!params) return;
    const { queue } = params;
    const queueMap: Record<typeof queue, { drain: () => Promise<void> }> = {
      discovery:  discoveryQueue,
      enrichment: enrichmentQueue,
      scoring:    scoringQueue,
    };
    logger.warn({ queue, correlationId: req.correlationId }, '[api:jobs] Queue drain requested');
    await queueMap[queue].drain();
    return reply.send({ success: true, data: { queue, message: 'Queue drained (waiting jobs removed)' } });
  });
}
