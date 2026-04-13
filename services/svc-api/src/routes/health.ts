import { FastifyInstance } from 'fastify';
import { getAvailableSources, scrapeLogRepository } from '@genlea/shared';
import type { ScraperSource } from '@genlea/shared';

const ALL_SOURCES: ScraperSource[] = [
  'explorium', 'wellfound', 'linkedin', 'indeed', 'glassdoor',
  'surelyremote', 'crunchbase', 'apollo', 'zoominfo', 'clay',
];

// Sources that need explicit credentials to be useful
const CREDENTIAL_REQUIRED: ScraperSource[] = [
  'explorium', 'linkedin', 'crunchbase', 'apollo', 'zoominfo', 'clay',
];

export async function healthRoutes(app: FastifyInstance) {
  app.get('/health/sources', async (_req, reply) => {
    const available = getAvailableSources();
    const recentLogs = await scrapeLogRepository.findRecent(undefined, 300);

    const sourceStats: Record<string, { total: number; failed: number; lastError?: string }> = {};
    for (const log of recentLogs) {
      const src = log.scraper as string;
      if (!sourceStats[src]) sourceStats[src] = { total: 0, failed: 0 };
      sourceStats[src].total++;
      if (log.status === 'failed') {
        sourceStats[src].failed++;
        if (!sourceStats[src].lastError && log.errors?.length) {
          sourceStats[src].lastError = String(log.errors[0]);
        }
      }
    }

    const sources = ALL_SOURCES.map(src => {
      const stats = sourceStats[src];
      const total  = stats?.total  ?? 0;
      const failed = stats?.failed ?? 0;
      return {
        source:         src,
        configured:     available.has(src),
        needsCredential: CREDENTIAL_REQUIRED.includes(src),
        recentTotal:    total,
        recentFailed:   failed,
        failRate:       total >= 3 ? Math.round((failed / total) * 100) : 0,
        lastError:      stats?.lastError,
      };
    });

    return reply.send({ success: true, data: { sources } });
  });
}
