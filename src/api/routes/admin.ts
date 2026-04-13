import { FastifyInstance } from 'fastify';
import { getDb } from '../../storage/mongo.client.js';
import { queueManager } from '../../core/queue.manager.js';
import { logger } from '../../utils/logger.js';
import { COLLECTIONS } from '../../storage/mongo.client.js';

export async function adminRoutes(app: FastifyInstance) {

  // POST /api/admin/reset-db
  // Drops all data collections and drains all queues — fresh start.
  app.post('/admin/reset-db', async (_req, reply) => {
    logger.warn('[api:admin] ⚠️  Database reset requested — wiping all collections and queues');

    const db = getDb();

    // Drop every data collection in parallel
    await Promise.allSettled([
      db.collection(COLLECTIONS.COMPANIES).deleteMany({}),
      db.collection(COLLECTIONS.CONTACTS).deleteMany({}),
      db.collection(COLLECTIONS.JOBS).deleteMany({}),
      db.collection(COLLECTIONS.SCRAPE_LOGS).deleteMany({}),
    ]);

    // Drain all queues
    await queueManager.drainAll().catch(err =>
      logger.warn({ err }, '[api:admin] Queue drain partial failure — continuing')
    );

    logger.warn('[api:admin] ✅ Database reset complete — all collections cleared, queues drained');

    return reply.send({
      success: true,
      data: { message: 'All collections cleared and queues drained. Ready for a fresh seed.' },
    });
  });
}
