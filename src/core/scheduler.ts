import cron from 'node-cron';
import { discoveryQueue } from './queue.manager.js';
import { generateRunId } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { ScraperSource } from '../types/index.js';

// ── Seed queries ──────────────────────────────────────────────────────────────
const SEED_QUERIES: Array<{
  source: ScraperSource;
  keywords: string;
  techStack?: string[];
}> = [
  // ── Wellfound — YC + early-stage ─────────────────────────────────────────
  { source: 'wellfound', keywords: 'Y Combinator startup software engineer',           techStack: ['nodejs', 'python', 'react'] },
  { source: 'wellfound', keywords: 'YC startup backend engineer seed series a',        techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'YC W24 startup engineer hiring',                   techStack: ['python', 'react'] },
  { source: 'wellfound', keywords: 'YC S24 startup engineer hiring',                   techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'seed stage startup software engineer US',          techStack: ['fullstack', 'nodejs'] },
  { source: 'wellfound', keywords: 'series a startup backend engineer US',             techStack: ['python', 'nodejs'] },
  { source: 'wellfound', keywords: 'early stage startup generative ai llm engineer',   techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'wellfound', keywords: 'pre-seed startup fullstack engineer US',           techStack: ['react', 'nodejs'] },

  // ── LinkedIn ──────────────────────────────────────────────────────────────
  { source: 'linkedin', keywords: 'Y Combinator startup software engineer hiring US',    techStack: ['nodejs', 'python'] },
  { source: 'linkedin', keywords: 'seed funded startup backend engineer US',             techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin', keywords: 'series a startup software engineer 10-50 employees', techStack: ['react', 'python'] },
  { source: 'linkedin', keywords: 'early stage saas startup engineer hiring US',        techStack: ['nodejs', 'nestjs'] },

  // ── Indeed ────────────────────────────────────────────────────────────────
  { source: 'indeed', keywords: 'early stage startup software engineer US seed series a' },
  { source: 'indeed', keywords: 'Y Combinator startup engineer hiring US' },
  { source: 'indeed', keywords: 'small startup backend python nodejs engineer US' },

  // ── Crunchbase ────────────────────────────────────────────────────────────
  { source: 'crunchbase', keywords: 'Y Combinator seed startup software US' },
  { source: 'crunchbase', keywords: 'series a startup saas software US 2023 2024' },

  // ── Apollo ────────────────────────────────────────────────────────────────
  { source: 'apollo', keywords: 'seed stage saas startup software engineer US',        techStack: ['nodejs', 'python'] },
  { source: 'apollo', keywords: 'series a startup tech company US 10 50 employees',   techStack: ['react', 'typescript'] },

  // ── Glassdoor ─────────────────────────────────────────────────────────────
  { source: 'glassdoor', keywords: 'software engineer startup seed series a US',         techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor', keywords: 'Y Combinator startup software engineer US',          techStack: ['python', 'typescript'] },
  { source: 'glassdoor', keywords: 'early stage startup backend engineer nodejs python', techStack: ['nodejs', 'python'] },

  // ── Surely Remote ─────────────────────────────────────────────────────────
  { source: 'surelyremote', keywords: 'software engineer startup seed series a',         techStack: ['nodejs', 'react', 'python'] },
  { source: 'surelyremote', keywords: 'backend engineer startup nodejs typescript',      techStack: ['nodejs', 'typescript'] },
  { source: 'surelyremote', keywords: 'fullstack engineer early stage startup',          techStack: ['react', 'nodejs', 'fullstack'] },
  { source: 'surelyremote', keywords: 'generative ai llm engineer startup',              techStack: ['python', 'generative-ai', 'ai'] },
];

// ── Track last seed time (readable by API) ─────────────────────────────────────
let _lastSeedAt: Date | null = null;
export function getLastSeedAt(): Date | null { return _lastSeedAt; }
export function getSeedQueryCount(): number { return SEED_QUERIES.length; }

// ── Enqueue one round of seed queries ─────────────────────────────────────────

export async function enqueueSeedRound(label = 'scheduled'): Promise<{ runId: string; queries: number }> {
  const runId = generateRunId();
  logger.info({ runId, queries: SEED_QUERIES.length, label }, '[scheduler] Enqueueing seed round');

  for (const q of SEED_QUERIES) {
    await discoveryQueue.add(
      `${label}:${q.source}:${runId}`,
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
        attempts:           3,
        backoff:            { type: 'exponential', delay: 5000 },
        removeOnComplete:   { count: 200 },
        removeOnFail:       { count: 100 },
      },
    );
  }

  _lastSeedAt = new Date();
  logger.info({ runId, label }, '[scheduler] ✅ Seed round enqueued');
  return { runId, queries: SEED_QUERIES.length };
}

// ── Start scheduler (cron every 2 hours + immediate run on startup) ───────────

export async function startScheduler(): Promise<void> {
  // Run immediately on startup so there's always fresh data after a restart
  await enqueueSeedRound('startup').catch(err =>
    logger.error({ err }, '[scheduler] Startup seed failed')
  );

  // Cron: every 2 hours — "0 */2 * * *"
  cron.schedule('0 */2 * * *', async () => {
    logger.info('[scheduler] ⏰ Cron triggered (every 2h)');
    await enqueueSeedRound('cron').catch(err =>
      logger.error({ err }, '[scheduler] Cron seed failed')
    );
  });

  // Nightly at 03:00 — deactivate jobs older than 90 days
  cron.schedule('0 3 * * *', async () => {
    logger.info('[scheduler] 🧹 Stale job cleanup starting');
    const count = await jobRepository.deactivateStale(90).catch(err => {
      logger.error({ err }, '[scheduler] Stale job cleanup failed');
      return 0;
    });
    logger.info({ deactivated: count }, '[scheduler] ✅ Stale job cleanup complete');
  });

  logger.info('[scheduler] ✅ Cron scheduler started — runs every 2 hours');
}
