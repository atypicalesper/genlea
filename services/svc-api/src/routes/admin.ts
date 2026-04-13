import { FastifyInstance } from 'fastify';
import { getDb, queueManager, COLLECTIONS, logger } from '@genlea/shared';

export async function adminRoutes(app: FastifyInstance) {

  app.post('/admin/reset-db', async (_req, reply) => {
    logger.warn('[api:admin] Database reset requested');

    const db = getDb();
    await Promise.allSettled([
      db.collection(COLLECTIONS.COMPANIES).deleteMany({}),
      db.collection(COLLECTIONS.CONTACTS).deleteMany({}),
      db.collection(COLLECTIONS.JOBS).deleteMany({}),
      db.collection(COLLECTIONS.SCRAPE_LOGS).deleteMany({}),
    ]);

    await queueManager.drainAll().catch(err =>
      logger.warn({ err }, '[api:admin] Queue drain partial failure')
    );

    logger.warn('[api:admin] Database reset complete');
    return reply.send({
      success: true,
      data: { message: 'All collections cleared and queues drained. Ready for a fresh seed.' },
    });
  });
}
