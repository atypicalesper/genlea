import 'dotenv-flow/config';
import { discoveryQueue, queueManager } from '../src/core/queue.manager.js';
import { generateRunId } from '../src/utils/random.js';
import { logger } from '../src/utils/logger.js';
import { ScraperSource } from '../src/types/index.js';

const SEED_QUERIES: Array<{ source: ScraperSource; keywords: string; techStack?: string[] }> = [
  // ── Wellfound — best for YC + early-stage ────────────────────────────────
  { source: 'wellfound',  keywords: 'Y Combinator startup software engineer',         techStack: ['nodejs', 'python', 'react'] },
  { source: 'wellfound',  keywords: 'YC startup backend engineer seed series a',      techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound',  keywords: 'YC W24 startup engineer hiring',                 techStack: ['python', 'react'] },
  { source: 'wellfound',  keywords: 'YC S24 startup engineer hiring',                 techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound',  keywords: 'seed stage startup software engineer US',        techStack: ['fullstack', 'nodejs'] },
  { source: 'wellfound',  keywords: 'series a startup backend engineer US',           techStack: ['python', 'nodejs'] },
  { source: 'wellfound',  keywords: 'early stage startup generative ai llm engineer', techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'wellfound',  keywords: 'pre-seed startup fullstack engineer US',         techStack: ['react', 'nodejs'] },
  // ── LinkedIn ─────────────────────────────────────────────────────────────
  { source: 'linkedin',   keywords: 'Y Combinator startup software engineer hiring US',    techStack: ['nodejs', 'python'] },
  { source: 'linkedin',   keywords: 'seed funded startup backend engineer US',             techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin',   keywords: 'series a startup software engineer 10-50 employees', techStack: ['react', 'python'] },
  { source: 'linkedin',   keywords: 'early stage saas startup engineer hiring US',        techStack: ['nodejs', 'nestjs'] },
  // ── Indeed ───────────────────────────────────────────────────────────────
  { source: 'indeed',     keywords: 'early stage startup software engineer US seed series a' },
  { source: 'indeed',     keywords: 'Y Combinator startup engineer hiring US' },
  { source: 'indeed',     keywords: 'small startup backend python nodejs engineer US' },
  // ── Crunchbase ───────────────────────────────────────────────────────────
  { source: 'crunchbase', keywords: 'Y Combinator seed startup software US' },
  { source: 'crunchbase', keywords: 'series a startup saas software US 2023 2024' },
  // ── Apollo ───────────────────────────────────────────────────────────────
  { source: 'apollo',     keywords: 'seed stage saas startup software engineer US',       techStack: ['nodejs', 'python'] },
  { source: 'apollo',     keywords: 'series a startup tech company US 10 50 employees',   techStack: ['react', 'typescript'] },
  // ── Glassdoor ───────────────────────────────────────────────────────────────
  { source: 'glassdoor',  keywords: 'software engineer startup seed series a US',         techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor',  keywords: 'Y Combinator startup software engineer US',          techStack: ['python', 'typescript'] },
  { source: 'glassdoor',  keywords: 'early stage startup backend engineer nodejs python', techStack: ['nodejs', 'python'] },
];

async function main() {
  // Accept repeat count as: `npm run seed -- 5`  or  `npm run seed:N` via SEED_TIMES env
  const arg   = process.argv[2];
  const times = Math.max(1, parseInt(arg ?? process.env['SEED_TIMES'] ?? '1', 10) || 1);

  const totalJobs = times * SEED_QUERIES.length;
  logger.info({ times, queriesPerRound: SEED_QUERIES.length, totalJobs }, '[seed] Starting seed run');

  let count = 0;
  for (let round = 0; round < times; round++) {
    const runId = generateRunId();
    for (const q of SEED_QUERIES) {
      await discoveryQueue.add(
        `seed:${q.source}:${runId}`,
        {
          runId,
          source: q.source,
          query: { keywords: q.keywords, location: 'United States', techStack: q.techStack, limit: 25 },
        },
        { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: { count: 1000 }, removeOnFail: { count: 500 } },
      );
      count++;
    }
    logger.info({ round: round + 1, times, enqueued: count }, '[seed] Round complete');
  }

  logger.info({ total: count }, '[seed] ✅ Seed complete');
  await queueManager.closeAll();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '[seed] Failed');
  process.exit(1);
});
