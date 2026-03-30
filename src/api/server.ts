import 'dotenv-flow/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { connectMongo } from '../storage/mongo.client.js';
import { queueManager } from '../core/queue.manager.js';
import { leadsRoutes } from './routes/leads.js';
import { exportRoutes } from './routes/export.js';
import { scrapeRoutes } from './routes/scrape.js';
import { jobsRoutes } from './routes/jobs.js';
import { logger } from '../utils/logger.js';

const server = Fastify({
  logger: false, // use our Pino instance instead
  trustProxy: true,
});

async function bootstrap() {
  await connectMongo();

  await server.register(cors, { origin: '*' });

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

  // Feature routes
  await server.register(leadsRoutes,  { prefix: '/api' });
  await server.register(exportRoutes, { prefix: '/api' });
  await server.register(scrapeRoutes, { prefix: '/api' });
  await server.register(jobsRoutes,   { prefix: '/api' });

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
