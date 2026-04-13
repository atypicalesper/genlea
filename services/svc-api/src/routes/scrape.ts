import { FastifyInstance } from 'fastify';
import { queueManager, enqueueSeedRound, generateRunId, logger } from '@genlea/shared';
import type { ScrapeQuery, ScraperSource } from '@genlea/shared';

const ALL_SOURCES: ScraperSource[] = [
  'linkedin', 'crunchbase', 'apollo', 'wellfound',
  'indeed', 'glassdoor', 'zoominfo', 'surelyremote',
];

export async function scrapeRoutes(app: FastifyInstance) {

  app.post('/seed', async (_req, reply) => {
    logger.info('[api:scrape] Manual seed triggered');
    const result = await enqueueSeedRound('manual').catch(err => {
      logger.error({ err }, '[api:scrape] Seed failed');
      throw err;
    });
    return reply.status(202).send({
      success: true,
      data: { runId: result.runId, queries: result.queries, message: `Seed round queued: ${result.queries} discovery jobs` },
    });
  });

  app.post<{
    Body: { source: ScraperSource; query: ScrapeQuery; limit?: number }
  }>('/scrape', async (req, reply) => {
    const { source, query, limit } = req.body;

    if (!ALL_SOURCES.includes(source)) {
      return reply.status(400).send({
        success: false,
        error: `Invalid source. Valid: ${ALL_SOURCES.join(', ')}`,
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
