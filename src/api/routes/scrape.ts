import { FastifyInstance } from 'fastify';
import { queueManager } from '../../core/queue.manager.js';
import { enqueueSeedRound } from '../../core/scheduler.js';
import { generateRunId } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';
import { scrapeBodySchema, parseBody } from '../schemas.js';

export async function scrapeRoutes(app: FastifyInstance) {

  // POST /api/seed — trigger all seed queries immediately
  app.post('/seed', async (req, reply) => {
    logger.info({ correlationId: req.correlationId }, '[api:scrape] Manual seed triggered');
    const result = await enqueueSeedRound('manual').catch(err => {
      logger.error({ err, correlationId: req.correlationId }, '[api:scrape] Seed failed');
      throw err;
    });
    return reply.status(202).send({
      success: true,
      data: { runId: result.runId, queries: result.queries, message: `Seed round queued: ${result.queries} discovery jobs` },
    });
  });

  // POST /api/scrape — trigger a single scraper with custom query
  app.post('/scrape', async (req, reply) => {
    const body = parseBody(scrapeBodySchema, req, reply);
    if (!body) return;
    const { source, query, limit } = body;

    const runId = generateRunId();
    await queueManager.addDiscoveryJob({
      runId,
      source,
      query: { ...query, limit: limit ?? query.limit ?? 25 },
      correlationId: req.correlationId,
    });

    logger.info({ runId, source, keywords: query.keywords, correlationId: req.correlationId }, '[api:scrape] Discovery job queued');

    return reply.status(202).send({
      success: true,
      data: { runId, message: `Discovery job queued for source: ${source}` },
    });
  });
}
