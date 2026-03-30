import 'dotenv-flow/config';
import { connectMongo, closeMongo } from '../src/storage/mongo.client.js';
import { companyRepository } from '../src/storage/repositories/company.repository.js';
import { queueManager } from '../src/core/queue.manager.js';
import { generateRunId } from '../src/utils/random.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  await connectMongo();
  const runId = generateRunId();

  const statusFilter   = process.argv[2]; // e.g. 'cold', 'warm', or omit for all
  const filter = statusFilter
    ? { status: statusFilter as import('../src/types/index.js').LeadStatus }
    : {};

  const companies = await companyRepository.findMany(filter, { sort: { score: 1 }, limit: 50000 });

  logger.info(
    { total: companies.length, filter: statusFilter, runId },
    '[rescore-all] Queuing scoring jobs'
  );

  let queued = 0;
  for (const co of companies) {
    if (!co._id) continue;
    await queueManager.addScoringJob({ runId, companyId: co._id });
    queued++;
  }

  logger.info({ queued, runId }, '[rescore-all] ✅ All scoring jobs queued — start workers to process');

  await queueManager.closeAll();
  await closeMongo();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '[rescore-all] Fatal error');
  process.exit(1);
});
