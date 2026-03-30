import { FastifyInstance } from 'fastify';
import { queueManager } from '../../core/queue.manager.js';
import { scrapeLogRepository } from '../../storage/repositories/scrape-log.repository.js';
import { logger } from '../../utils/logger.js';

export async function jobsRoutes(app: FastifyInstance) {

  // GET /api/jobs/status — live queue counts
  app.get('/jobs/status', async (_req, reply) => {
    logger.debug('[api:jobs] GET /jobs/status request');
    const stats = await queueManager.getQueueStats();
    return reply.send({ success: true, data: stats });
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
}
