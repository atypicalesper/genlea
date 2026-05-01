import { FastifyInstance } from 'fastify';
import { settingsRepository } from '../../storage/repositories/settings.repository.js';
import { logger } from '../../utils/logger.js';
import { settingsBodySchema, parseBody } from '../schemas.js';

export async function settingsRoutes(app: FastifyInstance) {

  // GET /api/settings
  app.get('/settings', async (_req, reply) => {
    const settings = await settingsRepository.get();
    return reply.send({ success: true, data: settings });
  });

  // PATCH /api/settings
  app.patch('/settings', async (req, reply) => {
    const body = parseBody(settingsBodySchema, req, reply);
    if (!body) return;
    const updates: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(body)) {
      if (val === undefined) continue;
      updates[key] = Array.isArray(val) ? val.map(v => v.trim()).filter(Boolean) : val;
    }
    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ success: false, error: 'No valid fields provided' });
    }
    const settings = await settingsRepository.patch(updates as any);
    logger.info({ updates, correlationId: req.correlationId }, '[api:settings] Settings updated');
    return reply.send({ success: true, data: settings });
  });
}
