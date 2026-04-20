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

  // Always available — ATS public JSON APIs via DuckDuckGo dorking
  available.add('greenhouse');
  available.add('lever');
  available.add('ashby');
  available.add('workable');

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
  const all: ScraperSource[] = ['explorium', 'wellfound', 'linkedin', 'indeed', 'glassdoor', 'surelyremote', 'crunchbase', 'apollo', 'zoominfo', 'clay', 'greenhouse', 'lever', 'ashby', 'workable'];
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
  // ── Explorium — API-based, most reliable, no browser needed ──────────────
  { source: 'explorium', keywords: 'nodejs typescript software engineer',            techStack: ['nodejs', 'typescript'] },
  { source: 'explorium', keywords: 'python software engineer',                       techStack: ['python'] },
  { source: 'explorium', keywords: 'react nextjs frontend engineer',                 techStack: ['react', 'nextjs'] },
  { source: 'explorium', keywords: 'java spring backend engineer',                   techStack: ['java'] },
  { source: 'explorium', keywords: 'golang backend engineer',                        techStack: ['golang'] },
  { source: 'explorium', keywords: 'machine learning ai engineer',                   techStack: ['python', 'ai', 'ml'] },
  { source: 'explorium', keywords: 'devops platform engineer cloud',                 techStack: ['devops', 'cloud'] },
  { source: 'explorium', keywords: 'mobile engineer ios android',                    techStack: ['ios', 'android'] },
  { source: 'explorium', keywords: 'data engineer analytics',                        techStack: ['data-engineering'] },
  { source: 'explorium', keywords: 'fullstack software engineer',                    techStack: ['fullstack'] },

  // ── Wellfound — funded US startups hiring across all sectors ─────────────
  { source: 'wellfound', keywords: 'YC startup software engineer',                   techStack: ['nodejs', 'python', 'react'] },
  { source: 'wellfound', keywords: 'seed stage startup software engineer US',        techStack: ['nodejs', 'python'] },
  { source: 'wellfound', keywords: 'series a startup backend engineer US',           techStack: ['nodejs', 'typescript'] },
  { source: 'wellfound', keywords: 'series b startup software engineer US',          techStack: ['python', 'react'] },
  { source: 'wellfound', keywords: 'remote startup software engineer US',            techStack: ['react', 'nodejs', 'fullstack'] },
  { source: 'wellfound', keywords: 'startup frontend engineer react nextjs US',      techStack: ['react', 'nextjs'] },
  { source: 'wellfound', keywords: 'startup mobile engineer ios android US',         techStack: ['ios', 'android'] },
  { source: 'wellfound', keywords: 'startup data engineer python US',                techStack: ['python', 'data-engineering'] },
  { source: 'wellfound', keywords: 'startup devops platform engineer US',            techStack: ['devops', 'cloud'] },
  { source: 'wellfound', keywords: 'pre-seed startup generative ai engineer',        techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'wellfound', keywords: 'bootstrapped startup software engineer US',      techStack: ['nodejs', 'python'] },
  { source: 'wellfound', keywords: 'startup java backend engineer US',               techStack: ['java'] },

  // ── LinkedIn — highest quality when session available ─────────────────────
  { source: 'linkedin', keywords: 'startup software engineer seed series a US',     techStack: ['nodejs', 'python'] },
  { source: 'linkedin', keywords: 'startup backend engineer 10-50 employees US',    techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin', keywords: 'startup frontend engineer hiring US',             techStack: ['react', 'nextjs'] },
  { source: 'linkedin', keywords: 'remote startup engineer distributed US',         techStack: ['python', 'nodejs'] },

  // ── Indeed — broadest reach for active job postings ──────────────────────
  { source: 'indeed', keywords: 'startup software engineer seed funded US' },
  { source: 'indeed', keywords: 'startup backend engineer series a US' },
  { source: 'indeed', keywords: 'startup fullstack engineer US remote' },
  { source: 'indeed', keywords: 'startup mobile engineer ios android US' },
  { source: 'indeed', keywords: 'startup data engineer analytics US' },
  { source: 'indeed', keywords: 'startup devops engineer cloud US' },
  { source: 'indeed', keywords: 'startup machine learning engineer US' },

  // ── Glassdoor ─────────────────────────────────────────────────────────────
  { source: 'glassdoor', keywords: 'startup software engineer seed series a US',    techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor', keywords: 'startup backend engineer python nodejs US',     techStack: ['python', 'nodejs'] },
  { source: 'glassdoor', keywords: 'startup frontend engineer react US',            techStack: ['react', 'typescript'] },
  { source: 'glassdoor', keywords: 'remote startup fullstack engineer US',          techStack: ['react', 'nodejs', 'fullstack'] },

  // ── Surely Remote — remote-first companies ────────────────────────────────
  { source: 'surelyremote', keywords: 'startup backend engineer nodejs python',     techStack: ['nodejs', 'python'] },
  { source: 'surelyremote', keywords: 'startup frontend engineer react',            techStack: ['react', 'typescript'] },
  { source: 'surelyremote', keywords: 'startup fullstack engineer',                 techStack: ['fullstack'] },
  { source: 'surelyremote', keywords: 'startup ai engineer python',                 techStack: ['python', 'ai', 'generative-ai'] },

  // ── Crunchbase — watchlist (hiringInStack: false) ─────────────────────────
  { source: 'crunchbase', keywords: 'seed startup software engineer US',            techStack: ['nodejs', 'python'] },
  { source: 'crunchbase', keywords: 'series a startup software engineer US',        techStack: ['python', 'react'] },
  { source: 'crunchbase', keywords: 'series b startup engineer US',                 techStack: ['nodejs', 'typescript', 'golang'] },

  // ── Apollo — watchlist (hiringInStack: false) ─────────────────────────────
  { source: 'apollo', keywords: 'startup software engineer US',                     techStack: ['nodejs', 'typescript'] },
  { source: 'apollo', keywords: 'startup backend engineer US',                      techStack: ['python', 'nodejs'] },
  { source: 'apollo', keywords: 'startup fullstack engineer US',                    techStack: ['react', 'nodejs'] },

  // ── ZoomInfo — watchlist (hiringInStack: false) ───────────────────────────
  { source: 'zoominfo', keywords: 'startup software engineer US seed series a',     techStack: ['nodejs', 'python', 'react'] },
  { source: 'zoominfo', keywords: 'startup backend engineer US',                    techStack: ['nodejs', 'typescript'] },

  // ── Clay — enrichment-grade database ─────────────────────────────────────
  { source: 'clay', keywords: 'startup software engineer US',                       techStack: ['nodejs', 'typescript'] },
  { source: 'clay', keywords: 'startup ai engineer US',                             techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'clay', keywords: 'startup fullstack engineer US',                      techStack: ['react', 'nodejs', 'fullstack'] },

  // ── Greenhouse ATS — public JSON API, reliable, actively hiring ──────────
  { source: 'greenhouse', keywords: '"software engineer" remote',                   techStack: ['nodejs', 'python'] },
  { source: 'greenhouse', keywords: '"backend engineer" "node"',                    techStack: ['nodejs', 'typescript'] },
  { source: 'greenhouse', keywords: '"frontend engineer" "react"',                  techStack: ['react', 'nextjs'] },
  { source: 'greenhouse', keywords: '"fullstack" "typescript"',                     techStack: ['fullstack', 'typescript'] },
  { source: 'greenhouse', keywords: '"ai engineer" OR "ml engineer"',               techStack: ['python', 'generative-ai', 'ml'] },
  { source: 'greenhouse', keywords: '"platform engineer" OR "devops"',              techStack: ['devops', 'cloud'] },

  // ── Lever ATS — public JSON API ──────────────────────────────────────────
  { source: 'lever', keywords: '"software engineer" remote US',                     techStack: ['nodejs', 'python'] },
  { source: 'lever', keywords: '"backend engineer" "python" OR "node"',             techStack: ['python', 'nodejs'] },
  { source: 'lever', keywords: '"frontend engineer" react',                         techStack: ['react', 'typescript'] },
  { source: 'lever', keywords: '"fullstack engineer" startup',                      techStack: ['fullstack'] },
  { source: 'lever', keywords: '"ai" OR "machine learning" engineer',               techStack: ['python', 'ai', 'generative-ai'] },

  // ── Ashby ATS — modern startup ATS, public posting API ───────────────────
  { source: 'ashby', keywords: '"software engineer" remote',                        techStack: ['nodejs', 'python'] },
  { source: 'ashby', keywords: '"backend" OR "fullstack" engineer',                 techStack: ['nodejs', 'typescript', 'fullstack'] },
  { source: 'ashby', keywords: '"frontend engineer" react nextjs',                  techStack: ['react', 'nextjs'] },
  { source: 'ashby', keywords: '"ai engineer" OR "llm" engineer',                   techStack: ['python', 'generative-ai'] },

  // ── Workable ATS — widely used, public jobs API ──────────────────────────
  { source: 'workable', keywords: '"software engineer" remote US',                  techStack: ['nodejs', 'python'] },
  { source: 'workable', keywords: '"backend engineer" python OR node',              techStack: ['python', 'nodejs'] },
  { source: 'workable', keywords: '"frontend engineer" react',                      techStack: ['react'] },
  { source: 'workable', keywords: '"fullstack engineer"',                           techStack: ['fullstack'] },
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
