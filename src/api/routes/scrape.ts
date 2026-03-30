import { FastifyInstance } from 'fastify';
import { queueManager } from '../../core/queue.manager.js';
import { ScrapeQuery, ScraperSource } from '../../types/index.js';
import { generateRunId } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';

const VALID_SOURCES: ScraperSource[] = ['linkedin', 'crunchbase', 'apollo'];

export async function scrapeRoutes(app: FastifyInstance) {

  // POST /api/scrape — trigger a manual scrape
  app.post<{
    Body: { source: ScraperSource; query: ScrapeQuery; limit?: number }
  }>('/scrape', async (req, reply) => {
    const { source, query, limit } = req.body;

    if (!VALID_SOURCES.includes(source)) {
      logger.warn({ source }, '[api:scrape] Invalid scraper source');
      return reply.status(400).send({
        success: false,
        error: `Invalid source. Valid: ${VALID_SOURCES.join(', ')}`,
      });
    }

    const runId = generateRunId();
    await queueManager.addDiscoveryJob({
      runId,
      source,
      query: { ...query, limit: limit ?? 25 },
    });

    logger.info({ runId, source, keywords: query.keywords }, '[api:scrape] Discovery job queued');

    return reply.status(202).send({
      success: true,
      data: { runId, message: `Discovery job queued for source: ${source}` },
    });
  });
}
