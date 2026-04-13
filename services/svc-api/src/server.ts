import 'dotenv-flow/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { FastifyAdapter } from '@bull-board/fastify';
import {
  connectMongo,
  discoveryQueue,
  enrichmentQueue,
  scoringQueue,
  queueManager,
  logAvailableSources,
  logger,
} from '@genlea/shared';
import { leadsRoutes }     from './routes/leads.js';
import { exportRoutes }    from './routes/export.js';
import { scrapeRoutes }    from './routes/scrape.js';
import { jobsRoutes }      from './routes/jobs.js';
import { companiesRoutes } from './routes/companies.js';
import { settingsRoutes }  from './routes/settings.js';
import { adminRoutes }     from './routes/admin.js';
import { healthRoutes }    from './routes/health.js';
import { dashboardRoutes } from './dashboard.js';

const REQUIRED_ENV: Record<string, string> = {
  MONGO_URI: 'MongoDB connection string (mongodb:// or mongodb+srv://)',
};

function checkEnv(): boolean {
  const missing = Object.entries(REQUIRED_ENV).filter(([key]) => !process.env[key]);
  if (missing.length === 0) return true;

  logger.error('[api] Server cannot start — required environment variables are missing:');
  for (const [key, description] of missing) {
    logger.error(`  ✗  ${key}  —  ${description}`);
  }
  return false;
}

const server = Fastify({ logger: false, trustProxy: true });

async function bootstrap() {
  if (!checkEnv()) process.exit(1);
  await connectMongo();

  await server.register(cors, { origin: '*' });

  // ── Bull Board (/queues) ───────────────────────────────────────────────────
  const bullBoardAdapter = new FastifyAdapter();
  createBullBoard({
    queues: ([
      new BullMQAdapter(discoveryQueue),
      new BullMQAdapter(enrichmentQueue),
      new BullMQAdapter(scoringQueue),
    ] as any[]),
    serverAdapter: bullBoardAdapter,
  });
  bullBoardAdapter.setBasePath('/queues');
  await server.register(bullBoardAdapter.registerPlugin(), { basePath: '/queues', prefix: '/queues' });

  const port = parseInt(process.env['API_PORT'] ?? '4000');
  logger.info(`[api] Bull Board: http://localhost:${port}/queues`);

  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'genlea-api',
  }));

  server.get('/health/queues', async () => ({
    queues: await queueManager.getQueueStats(),
  }));

  server.get('/', async (_req, reply) => reply.redirect('/dashboard'));

  await server.register(dashboardRoutes);
  await server.register(leadsRoutes,     { prefix: '/api' });
  await server.register(companiesRoutes, { prefix: '/api' });
  await server.register(exportRoutes,    { prefix: '/api' });
  await server.register(scrapeRoutes,    { prefix: '/api' });
  await server.register(jobsRoutes,      { prefix: '/api' });
  await server.register(settingsRoutes,  { prefix: '/api' });
  await server.register(adminRoutes,     { prefix: '/api' });
  await server.register(healthRoutes,    { prefix: '/api' });

  logger.info('[api] Active discovery sources:');
  logAvailableSources();

  const host = process.env['API_HOST'] ?? '0.0.0.0';
  await server.listen({ port, host });
  logger.info({ port, host }, '[api] GenLea API server started');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[api] Shutdown signal received');
    await server.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
  logger.error({ err }, '[api] Fatal startup error');
  process.exit(1);
});

export { server };
