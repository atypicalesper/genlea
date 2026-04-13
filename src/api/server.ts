import 'dotenv-flow/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { FastifyAdapter } from '@bull-board/fastify';
import { connectMongo } from '../storage/mongo.client.js';
import { discoveryQueue, enrichmentQueue, scoringQueue, queueManager } from '../core/queue.manager.js';
import { leadsRoutes } from './routes/leads.js';
import { exportRoutes } from './routes/export.js';
import { scrapeRoutes } from './routes/scrape.js';
import { jobsRoutes } from './routes/jobs.js';
import { companiesRoutes } from './routes/companies.js';
import { settingsRoutes } from './routes/settings.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './dashboard.js';
import { logger } from '../utils/logger.js';

const REQUIRED_ENV: Record<string, string> = {
  MONGO_URI:  'MongoDB connection string (mongodb:// or mongodb+srv://)',
};

const OPTIONAL_ENV: Record<string, string> = {
  REDIS_URL:      'Redis connection URL — defaults to redis://localhost:6379',
  REDIS_PASSWORD: 'Redis auth password — optional',
  MONGO_DB_NAME:  'MongoDB database name — defaults to "genlea"',
  API_PORT:       'HTTP port — defaults to 4000',
  API_HOST:       'Bind address — defaults to 0.0.0.0',
};

function checkEnv(): boolean {
  const missing = Object.entries(REQUIRED_ENV).filter(([key]) => !process.env[key]);

  if (missing.length === 0) return true;

  logger.error('[api] Server cannot start — required environment variables are missing:');
  for (const [key, description] of missing) {
    logger.error(`  ✗  ${key}  —  ${description}`);
  }

  const presentOptional = Object.keys(OPTIONAL_ENV).filter(k => process.env[k]);
  const absentOptional  = Object.keys(OPTIONAL_ENV).filter(k => !process.env[k]);

  if (presentOptional.length) {
    logger.info('[api] Optional env vars present: ' + presentOptional.join(', '));
  }
  if (absentOptional.length) {
    logger.info('[api] Optional env vars not set (defaults apply): ' + absentOptional.join(', '));
  }

  logger.info('[api] Copy .env.example → .env and fill in the missing values');
  return false;
}

const server = Fastify({
  logger: false, // use our Pino instance instead
  trustProxy: true,
});

async function bootstrap() {
  if (!checkEnv()) process.exit(1);
  await connectMongo();

  await server.register(cors, { origin: '*' });

  // ── Bull Board (/queues) ───────────────────────────────────────────────────
  const bullBoardAdapter = new FastifyAdapter();
  createBullBoard({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    queues: ([
      new BullMQAdapter(discoveryQueue),
      new BullMQAdapter(enrichmentQueue),
      new BullMQAdapter(scoringQueue),
    ] as any[]),
    serverAdapter: bullBoardAdapter,
  });
  bullBoardAdapter.setBasePath('/queues');
  await server.register(bullBoardAdapter.registerPlugin(), { basePath: '/queues', prefix: '/queues' });
  logger.info(`[api] Bull Board: http://localhost:${parseInt(process.env['API_PORT'] ?? '4001')}/queues`);

  // Health check
  server.get('/health', async () => ({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'genlea-api',
  }));

  // Queue stats
  server.get('/health/queues', async () => {
    const stats = await queueManager.getQueueStats();
    return { queues: stats };
  });

  // Root redirect → dashboard
  server.get('/', async (_req, reply) => reply.redirect('/dashboard'));

  // Dashboard
  await server.register(dashboardRoutes);

  // Feature routes
  await server.register(leadsRoutes,     { prefix: '/api' });
  await server.register(companiesRoutes, { prefix: '/api' });
  await server.register(exportRoutes,    { prefix: '/api' });
  await server.register(scrapeRoutes,    { prefix: '/api' });
  await server.register(jobsRoutes,      { prefix: '/api' });
  await server.register(settingsRoutes,  { prefix: '/api' });
  await server.register(adminRoutes,     { prefix: '/api' });

  const { logAvailableSources } = await import('../core/scheduler.js');
  logger.info('[api] Active discovery sources:');
  logAvailableSources();

  const port = parseInt(process.env['API_PORT'] ?? '4000');
  const host = process.env['API_HOST'] ?? '0.0.0.0';

  await server.listen({ port, host });
  logger.info({ port, host }, '[api] GenLea API server started');
  logger.info('[api] Swagger: not configured — add @fastify/swagger if needed');

  // Graceful shutdown — finish in-flight requests before exiting
  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[api] Shutdown signal received — closing server');
    await server.close();
    logger.info('[api] Server closed — exiting');
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
