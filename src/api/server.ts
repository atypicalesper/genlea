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
import { dashboardRoutes } from './dashboard.js';
import { logger } from '../utils/logger.js';

const server = Fastify({
  logger: false, // use our Pino instance instead
  trustProxy: true,
});

async function bootstrap() {
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
  logger.info('[api] Bull Board: http://localhost:4000/queues');

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

  // Dashboard
  await server.register(dashboardRoutes);

  // Feature routes
  await server.register(leadsRoutes,     { prefix: '/api' });
  await server.register(companiesRoutes, { prefix: '/api' });
  await server.register(exportRoutes,    { prefix: '/api' });
  await server.register(scrapeRoutes,    { prefix: '/api' });
  await server.register(jobsRoutes,      { prefix: '/api' });

  const port = parseInt(process.env['API_PORT'] ?? '4000');
  const host = process.env['API_HOST'] ?? '0.0.0.0';

  await server.listen({ port, host });
  logger.info({ port, host }, '[api] GenLea API server started');
  logger.info('[api] Swagger: not configured — add @fastify/swagger if needed');
}

bootstrap().catch(err => {
  logger.error({ err }, '[api] Fatal startup error');
  process.exit(1);
});

export { server };
