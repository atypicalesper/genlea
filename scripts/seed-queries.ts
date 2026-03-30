import 'dotenv-flow/config';
import { queueManager } from '../src/core/queue.manager.js';
import { generateRunId } from '../src/utils/random.js';
import { logger } from '../src/utils/logger.js';

// Seed queries that target US tech companies likely to have high South Asian dev teams
const SEED_QUERIES = [
  { source: 'wellfound', keywords: 'nodejs backend engineer', techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'python ai machine learning', techStack: ['python', 'ml', 'ai'] },
  { source: 'wellfound', keywords: 'react frontend engineer startup', techStack: ['react', 'nextjs'] },
  { source: 'wellfound', keywords: 'fullstack engineer saas', techStack: ['fullstack', 'nodejs'] },
  { source: 'wellfound', keywords: 'generative ai llm engineer', techStack: ['generative-ai', 'python'] },
  { source: 'linkedin',   keywords: 'software startup nodejs hiring US', techStack: ['nodejs'] },
  { source: 'linkedin',   keywords: 'fintech startup react python developer US' },
  { source: 'linkedin',   keywords: 'saas startup nestjs typescript hiring' },
  { source: 'crunchbase', keywords: 'software startup nodejs python AI' },
  { source: 'apollo',     keywords: 'saas fintech software startup', techStack: ['nodejs', 'python'] },
];

async function main() {
  logger.info('[seed] Seeding discovery queue with initial queries...');
  const runId = generateRunId();
  let count = 0;

  for (const q of SEED_QUERIES) {
    await queueManager.addDiscoveryJob({
      runId,
      source: q.source as any,
      query: {
        keywords:  q.keywords,
        location:  'United States',
        techStack: q.techStack,
        limit:     25,
      },
    });
    count++;
    logger.info({ source: q.source, keywords: q.keywords }, '[seed] Discovery job queued');
  }

  logger.info({ runId, count }, '[seed] ✅ All seed queries enqueued');
  await queueManager.closeAll();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '[seed] Failed');
  process.exit(1);
});
