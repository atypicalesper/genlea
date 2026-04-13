import { FastifyInstance } from 'fastify';
import { settingsRepository, logger } from '@genlea/shared';

export async function settingsRoutes(app: FastifyInstance) {

  app.get('/settings', async (_req, reply) => {
    const settings = await settingsRepository.get();
    return reply.send({ success: true, data: settings });
  });

  app.patch<{ Body: Record<string, unknown> }>('/settings', async (req, reply) => {
    const numericFields = ['originRatioThreshold', 'originRatioMinSample', 'leadScoreHotVerifiedThreshold', 'leadScoreHotThreshold', 'leadScoreWarmThreshold', 'leadScoreColdThreshold', 'workerConcurrencyDiscovery', 'workerConcurrencyEnrichment', 'workerConcurrencyScoring'];
    const arrayFields   = ['targetTechTags', 'highValueIndustries'];
    const updates: Record<string, unknown> = {};

    const RANGES: Record<string, [number, number]> = {
      originRatioThreshold:          [0.01, 1.0],
      originRatioMinSample:          [1, 200],
      leadScoreHotVerifiedThreshold: [1, 100],
      leadScoreHotThreshold:         [1, 100],
      leadScoreWarmThreshold:        [1, 100],
      leadScoreColdThreshold:        [0, 100],
      workerConcurrencyDiscovery:    [1, 50],
      workerConcurrencyEnrichment:   [1, 50],
      workerConcurrencyScoring:      [1, 100],
    };
    for (const key of numericFields) {
      if (key in req.body) {
        const val = Number(req.body[key]);
        const [min, max] = RANGES[key] ?? [0, Infinity];
        if (!isNaN(val) && isFinite(val) && val >= min && val <= max) updates[key] = val;
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
