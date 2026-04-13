import cron from 'node-cron';
import { discoveryQueue } from './queue.manager.js';
import { generateRunId } from '../utils/random.js';
import { logger } from '../utils/logger.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { ScraperSource } from '../types/index.js';

// ── Available sources — derived from env at startup ───────────────────────────
// Sync checks only (no I/O) — scrapers do their own full check inside isAvailable().
// This just prevents queueing jobs for sources we know won't work.

export function getAvailableSources(): Set<ScraperSource> {
  const available = new Set<ScraperSource>();

  // Always available — browser-only, no credentials required
  available.add('wellfound');
  available.add('indeed');
  available.add('glassdoor');
  available.add('surelyremote');

  // API key required
  if (process.env['EXPLORIUM_API_KEY'])  available.add('explorium');
  if (process.env['APOLLO_API_KEY'])     available.add('apollo');
  if (process.env['CLAY_API_KEY'])       available.add('clay');
  if (process.env['CRUNCHBASE_API_KEY']) available.add('crunchbase');

  // Full credentials required
  if (process.env['ZOOMINFO_USERNAME'] && process.env['ZOOMINFO_PASSWORD']) available.add('zoominfo');
  if (process.env['LI_USERNAME'])        available.add('linkedin');

  return available;
}

export function logAvailableSources(): void {
  const available = getAvailableSources();
  const all: ScraperSource[] = ['explorium', 'wellfound', 'linkedin', 'indeed', 'glassdoor', 'surelyremote', 'crunchbase', 'apollo', 'zoominfo', 'clay'];
  for (const src of all) {
    if (available.has(src)) {
      logger.info(`  ✓  ${src}`);
    } else {
      logger.warn(`  ✗  ${src}  — credentials not configured, skipping`);
    }
  }
}

// ── Seed queries ──────────────────────────────────────────────────────────────
const SEED_QUERIES: Array<{
  source: ScraperSource;
  keywords: string;
  techStack?: string[];
}> = [
  // ── Explorium — API-based, most reliable, no browser needed ─────────────
  { source: 'explorium', keywords: 'nodejs typescript saas startup',                   techStack: ['nodejs', 'typescript'] },
  { source: 'explorium', keywords: 'python ai ml generative startup',                  techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'explorium', keywords: 'react nextjs fullstack saas startup',              techStack: ['react', 'nextjs', 'typescript'] },
  { source: 'explorium', keywords: 'python django fastapi backend startup',            techStack: ['python', 'django', 'fastapi'] },
  { source: 'explorium', keywords: 'golang rust backend infrastructure startup',       techStack: ['golang', 'rust'] },
  { source: 'explorium', keywords: 'nodejs nestjs backend saas startup',              techStack: ['nodejs', 'nestjs'] },

  // ── Wellfound — most reliable free source for funded US startups ──────────
  { source: 'wellfound', keywords: 'YC W24 startup software engineer',                techStack: ['nodejs', 'python', 'react'] },
  { source: 'wellfound', keywords: 'YC S24 startup software engineer',                techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'YC W23 startup backend engineer',                 techStack: ['python', 'react'] },
  { source: 'wellfound', keywords: 'seed stage fintech startup engineer US',          techStack: ['nodejs', 'python'] },
  { source: 'wellfound', keywords: 'seed stage AI startup engineer US',               techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'wellfound', keywords: 'series a saas startup backend engineer US',       techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'series a healthtech startup engineer US',         techStack: ['python', 'react'] },
  { source: 'wellfound', keywords: 'series a fintech startup engineer US',            techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'remote first startup fullstack engineer US',      techStack: ['react', 'nodejs', 'fullstack'] },
  { source: 'wellfound', keywords: 'distributed team startup backend engineer US',    techStack: ['python', 'nodejs'] },
  { source: 'wellfound', keywords: 'pre-seed startup generative ai llm engineer',     techStack: ['python', 'generative-ai'] },
  { source: 'wellfound', keywords: 'bootstrapped saas startup nodejs engineer',       techStack: ['nodejs', 'nestjs'] },

  // ── LinkedIn — requires session but highest quality ────────────────────────
  { source: 'linkedin', keywords: 'YC startup software engineer seed series a US',   techStack: ['nodejs', 'python'] },
  { source: 'linkedin', keywords: 'seed funded saas startup engineer 10-50 US',      techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin', keywords: 'series a AI startup engineer hiring US',           techStack: ['python', 'generative-ai'] },
  { source: 'linkedin', keywords: 'remote startup fullstack engineer distributed',    techStack: ['react', 'nodejs'] },

  // ── Indeed — catches active job postings not on other boards ─────────────
  { source: 'indeed', keywords: 'startup software engineer seed funded US' },
  { source: 'indeed', keywords: 'early stage startup backend python nodejs US' },
  { source: 'indeed', keywords: 'startup fullstack engineer series a US remote' },
  { source: 'indeed', keywords: 'AI startup machine learning engineer US seed' },
  { source: 'indeed', keywords: 'saas startup typescript react engineer US' },

  // ── Glassdoor ─────────────────────────────────────────────────────────────
  { source: 'glassdoor', keywords: 'startup software engineer seed series a US',     techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor', keywords: 'AI startup engineer python typescript US',       techStack: ['python', 'typescript', 'generative-ai'] },
  { source: 'glassdoor', keywords: 'fintech startup backend engineer US',            techStack: ['nodejs', 'python'] },
  { source: 'glassdoor', keywords: 'remote startup fullstack engineer US',           techStack: ['react', 'nodejs', 'fullstack'] },

  // ── Surely Remote — remote-first companies are top outsourcing targets ────
  { source: 'surelyremote', keywords: 'startup backend engineer nodejs python',      techStack: ['nodejs', 'python'] },
  { source: 'surelyremote', keywords: 'startup AI engineer generative llm',          techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'surelyremote', keywords: 'startup fullstack react typescript',          techStack: ['react', 'typescript', 'fullstack'] },
  { source: 'surelyremote', keywords: 'saas startup backend typescript nestjs',      techStack: ['nodejs', 'nestjs', 'typescript'] },

  // ── Crunchbase — database source (hiringInStack: false → watchlist) ─────
  { source: 'crunchbase', keywords: 'seed stage saas startup software US',          techStack: ['nodejs', 'python'] },
  { source: 'crunchbase', keywords: 'series a ai ml startup US',                    techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'crunchbase', keywords: 'series b fintech devtools startup US',         techStack: ['nodejs', 'typescript', 'golang'] },

  // ── Apollo — database source (hiringInStack: false → watchlist) ──────────
  { source: 'apollo', keywords: 'saas startup nodejs typescript engineer US',       techStack: ['nodejs', 'typescript'] },
  { source: 'apollo', keywords: 'ai ml startup python engineer US',                 techStack: ['python', 'generative-ai'] },
  { source: 'apollo', keywords: 'fintech startup fullstack engineer US',            techStack: ['react', 'nodejs'] },

  // ── ZoomInfo — database source (hiringInStack: false → watchlist) ────────
  { source: 'zoominfo', keywords: 'tech startup software engineer US seed series a', techStack: ['nodejs', 'python', 'react'] },
  { source: 'zoominfo', keywords: 'saas startup backend engineer US',               techStack: ['nodejs', 'typescript'] },

  // ── Clay — enrichment-grade database source ───────────────────────────────
  { source: 'clay', keywords: 'saas startup nodejs typescript engineer US',         techStack: ['nodejs', 'typescript'] },
  { source: 'clay', keywords: 'ai ml startup python generative engineer US',        techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'clay', keywords: 'fintech startup fullstack react engineer US',        techStack: ['react', 'nodejs', 'fullstack'] },
];

// ── Configurable thresholds ────────────────────────────────────────────────────
const DISCOVERY_BACKLOG_THRESHOLD = parseInt(process.env['DISCOVERY_BACKLOG_THRESHOLD'] ?? '200', 10);
const STALE_JOB_DAYS              = parseInt(process.env['STALE_JOB_DAYS']              ?? '90',  10);

// ── Track last seed time (readable by API) ─────────────────────────────────────
let _lastSeedAt: Date | null = null;
export function getLastSeedAt(): Date | null { return _lastSeedAt; }
export function getSeedQueryCount(): number { return SEED_QUERIES.length; }

// ── Enqueue one round of seed queries ─────────────────────────────────────────

export async function enqueueSeedRound(label = 'scheduled'): Promise<{ runId: string; queries: number }> {
  // Skip if there's already a large backlog — avoid unbounded queue growth
  if (label === 'cron' || label === 'scheduled') {
    const counts = await discoveryQueue.getJobCounts();
    const waiting = counts.waiting ?? 0;
    if (waiting > DISCOVERY_BACKLOG_THRESHOLD) {
      logger.warn({ waiting, threshold: DISCOVERY_BACKLOG_THRESHOLD, label }, '[scheduler] Discovery backlog too large — skipping seed round');
      return { runId: 'skipped', queries: 0 };
    }
  }

  const availableSources = getAvailableSources();
  const activeQueries = SEED_QUERIES.filter(q => availableSources.has(q.source));

  const runId = generateRunId();
  logger.info({ runId, total: SEED_QUERIES.length, active: activeQueries.length, label }, '[scheduler] Enqueueing seed round');

  for (const q of activeQueries) {
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
  logger.info({ runId, label, queued: activeQueries.length }, '[scheduler] ✅ Seed round enqueued');
  return { runId, queries: activeQueries.length };
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
    const count = await jobRepository.deactivateStale(STALE_JOB_DAYS).catch(err => {
      logger.error({ err }, '[scheduler] Stale job cleanup failed');
      return 0;
    });
    logger.info({ deactivated: count }, '[scheduler] ✅ Stale job cleanup complete');
  });

  logger.info('[scheduler] ✅ Cron scheduler started — runs every 2 hours');
}
