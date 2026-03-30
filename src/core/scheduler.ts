import { discoveryQueue } from './queue.manager.js';
import { generateRunId } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { ScraperSource } from '../types/index.js';

// ── Seed queries ──────────────────────────────────────────────────────────────
// Same set as scripts/seed-queries.ts — single source of truth here.
const SEED_QUERIES: Array<{
  source: ScraperSource;
  keywords: string;
  techStack?: string[];
}> = [
  // ── Wellfound (formerly AngelList) — best source for YC + early-stage ──────
  // YC companies predominantly post here; no auth required
  { source: 'wellfound', keywords: 'Y Combinator startup software engineer',          techStack: ['nodejs', 'python', 'react'] },
  { source: 'wellfound', keywords: 'YC startup backend engineer seed series a',       techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'YC W24 startup engineer hiring',                  techStack: ['python', 'react'] },
  { source: 'wellfound', keywords: 'YC S24 startup engineer hiring',                  techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'seed stage startup software engineer US',         techStack: ['fullstack', 'nodejs'] },
  { source: 'wellfound', keywords: 'series a startup backend engineer US',            techStack: ['python', 'nodejs'] },
  { source: 'wellfound', keywords: 'early stage startup generative ai llm engineer',  techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'wellfound', keywords: 'pre-seed startup fullstack engineer US',          techStack: ['react', 'nodejs'] },

  // ── LinkedIn ─────────────────────────────────────────────────────────────────
  { source: 'linkedin', keywords: 'Y Combinator startup software engineer hiring US',    techStack: ['nodejs', 'python'] },
  { source: 'linkedin', keywords: 'seed funded startup backend engineer US',             techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin', keywords: 'series a startup software engineer 10-50 employees', techStack: ['react', 'python'] },
  { source: 'linkedin', keywords: 'early stage saas startup engineer hiring US',        techStack: ['nodejs', 'nestjs'] },

  // ── Indeed ───────────────────────────────────────────────────────────────────
  { source: 'indeed', keywords: 'early stage startup software engineer US seed series a' },
  { source: 'indeed', keywords: 'Y Combinator startup engineer hiring US' },
  { source: 'indeed', keywords: 'small startup backend python nodejs engineer US' },

  // ── Crunchbase ───────────────────────────────────────────────────────────────
  // Web mode searches for YC-backed + seed/series-A companies
  { source: 'crunchbase', keywords: 'Y Combinator seed startup software US' },
  { source: 'crunchbase', keywords: 'series a startup saas software US 2023 2024' },

  // ── Apollo ───────────────────────────────────────────────────────────────────
  { source: 'apollo', keywords: 'seed stage saas startup software engineer US',  techStack: ['nodejs', 'python'] },
  { source: 'apollo', keywords: 'series a startup tech company US 10 50 employees', techStack: ['react', 'typescript'] },

  // ── Glassdoor ────────────────────────────────────────────────────────────────
  { source: 'glassdoor', keywords: 'software engineer startup seed series a US',         techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor', keywords: 'Y Combinator startup software engineer US',          techStack: ['python', 'typescript'] },
  { source: 'glassdoor', keywords: 'early stage startup backend engineer nodejs python', techStack: ['nodejs', 'python'] },
];

// ── Schedule ──────────────────────────────────────────────────────────────────

export async function startScheduler(): Promise<void> {
  const intervalHours = parseInt(process.env['SCRAPE_INTERVAL_HOURS'] ?? '6', 10);
  const intervalMs    = intervalHours * 60 * 60 * 1000;

  logger.info({ intervalHours, queries: SEED_QUERIES.length }, '[scheduler] Registering repeatable discovery jobs');

  // Remove any stale repeatable jobs from previous runs (different interval etc.)
  const existing = await discoveryQueue.getRepeatableJobs();
  for (const job of existing) {
    await discoveryQueue.removeRepeatableByKey(job.key);
  }

  const runId = generateRunId();

  for (const q of SEED_QUERIES) {
    const jobName = `scheduled:${q.source}:${q.keywords.slice(0, 30)}`;

    await discoveryQueue.add(
      jobName,
      {
        runId,
        source: q.source,
        query: {
          keywords:  q.keywords,
          location:  'United States',
          techStack: q.techStack,
          limit:     25,
        },
      },
      {
        repeat:             { every: intervalMs },
        // Also run immediately on first startup
        delay:              0,
        attempts:           3,
        backoff:            { type: 'exponential', delay: 5000 },
        removeOnComplete:   { count: 100 },
        removeOnFail:       { count: 50 },
      },
    );

    logger.debug({ source: q.source, keywords: q.keywords, intervalHours }, '[scheduler] Repeatable job registered');
  }

  logger.info(
    { count: SEED_QUERIES.length, intervalHours, nextRun: new Date(Date.now() + intervalMs).toISOString() },
    '[scheduler] ✅ All discovery jobs scheduled'
  );
}
