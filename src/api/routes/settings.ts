import { FastifyInstance } from 'fastify';
import { settingsRepository } from '../../storage/repositories/settings.repository.js';
import { logger } from '../../utils/logger.js';

export async function settingsRoutes(app: FastifyInstance) {

  // GET /api/settings
  app.get('/settings', async (_req, reply) => {
    const settings = await settingsRepository.get();
    return reply.send({ success: true, data: settings });
  });

  // PATCH /api/settings
  app.patch<{ Body: Record<string, unknown> }>('/settings', async (req, reply) => {
    const numericFields = ['originRatioThreshold', 'originRatioMinSample', 'leadScoreHotVerifiedThreshold', 'leadScoreHotThreshold', 'leadScoreWarmThreshold', 'leadScoreColdThreshold', 'workerConcurrencyDiscovery', 'workerConcurrencyEnrichment', 'workerConcurrencyScoring'];
    const arrayFields   = ['targetTechTags', 'highValueIndustries'];
    const updates: Record<string, unknown> = {};

    for (const key of numericFields) {
      if (key in req.body) {
        const val = Number(req.body[key]);
        if (!isNaN(val)) updates[key] = val;
      }
    }
    for (const key of arrayFields) {
      if (key in req.body) {
        const val = req.body[key];
        if (Array.isArray(val) && val.every(v => typeof v === 'string')) {
          updates[key] = val.map((v: string) => v.trim()).filter(Boolean);
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return reply.status(400).send({ success: false, error: 'No valid fields provided' });
    }
    const settings = await settingsRepository.patch(updates as any);
    logger.info({ updates }, '[api:settings] Settings updated');
    return reply.send({ success: true, data: settings });
  });
}
