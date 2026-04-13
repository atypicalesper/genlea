import { discoveryQueue } from './queue/queue.manager.js';
import { generateRunId } from './utils/random.js';
import { logger } from './utils/logger.js';
import { ScraperSource } from './types/index.js';

export const SEED_QUERIES: Array<{
  source: ScraperSource;
  keywords: string;
  techStack?: string[];
}> = [
  // ── Explorium ────────────────────────────────────────────────────────────────
  { source: 'explorium', keywords: 'nodejs typescript saas startup',                   techStack: ['nodejs', 'typescript'] },
  { source: 'explorium', keywords: 'python ai ml generative startup',                  techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'explorium', keywords: 'react nextjs fullstack saas startup',              techStack: ['react', 'nextjs', 'typescript'] },
  { source: 'explorium', keywords: 'python django fastapi backend startup',            techStack: ['python', 'django', 'fastapi'] },
  { source: 'explorium', keywords: 'golang rust backend infrastructure startup',       techStack: ['golang', 'rust'] },
  { source: 'explorium', keywords: 'nodejs nestjs backend saas startup',              techStack: ['nodejs', 'nestjs'] },

  // ── Wellfound ────────────────────────────────────────────────────────────────
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

  // ── LinkedIn ─────────────────────────────────────────────────────────────────
  { source: 'linkedin', keywords: 'YC startup software engineer seed series a US',   techStack: ['nodejs', 'python'] },
  { source: 'linkedin', keywords: 'seed funded saas startup engineer 10-50 US',      techStack: ['nodejs', 'typescript'] },
  { source: 'linkedin', keywords: 'series a AI startup engineer hiring US',           techStack: ['python', 'generative-ai'] },
  { source: 'linkedin', keywords: 'remote startup fullstack engineer distributed',    techStack: ['react', 'nodejs'] },

  // ── Indeed ───────────────────────────────────────────────────────────────────
  { source: 'indeed', keywords: 'startup software engineer seed funded US' },
  { source: 'indeed', keywords: 'early stage startup backend python nodejs US' },
  { source: 'indeed', keywords: 'startup fullstack engineer series a US remote' },
  { source: 'indeed', keywords: 'AI startup machine learning engineer US seed' },
  { source: 'indeed', keywords: 'saas startup typescript react engineer US' },

  // ── Glassdoor ────────────────────────────────────────────────────────────────
  { source: 'glassdoor', keywords: 'startup software engineer seed series a US',     techStack: ['nodejs', 'react', 'python'] },
  { source: 'glassdoor', keywords: 'AI startup engineer python typescript US',       techStack: ['python', 'typescript', 'generative-ai'] },
  { source: 'glassdoor', keywords: 'fintech startup backend engineer US',            techStack: ['nodejs', 'python'] },
  { source: 'glassdoor', keywords: 'remote startup fullstack engineer US',           techStack: ['react', 'nodejs', 'fullstack'] },

  // ── Surely Remote ────────────────────────────────────────────────────────────
  { source: 'surelyremote', keywords: 'startup backend engineer nodejs python',      techStack: ['nodejs', 'python'] },
  { source: 'surelyremote', keywords: 'startup AI engineer generative llm',          techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'surelyremote', keywords: 'startup fullstack react typescript',          techStack: ['react', 'typescript', 'fullstack'] },
  { source: 'surelyremote', keywords: 'saas startup backend typescript nestjs',      techStack: ['nodejs', 'nestjs', 'typescript'] },

  // ── Crunchbase ───────────────────────────────────────────────────────────────
  { source: 'crunchbase', keywords: 'seed stage saas startup software US',          techStack: ['nodejs', 'python'] },
  { source: 'crunchbase', keywords: 'series a ai ml startup US',                    techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'crunchbase', keywords: 'series b fintech devtools startup US',         techStack: ['nodejs', 'typescript', 'golang'] },

  // ── Apollo ───────────────────────────────────────────────────────────────────
  { source: 'apollo', keywords: 'saas startup nodejs typescript engineer US',       techStack: ['nodejs', 'typescript'] },
  { source: 'apollo', keywords: 'ai ml startup python engineer US',                 techStack: ['python', 'generative-ai'] },
  { source: 'apollo', keywords: 'fintech startup fullstack engineer US',            techStack: ['react', 'nodejs'] },

  // ── ZoomInfo ─────────────────────────────────────────────────────────────────
  { source: 'zoominfo', keywords: 'tech startup software engineer US seed series a', techStack: ['nodejs', 'python', 'react'] },
  { source: 'zoominfo', keywords: 'saas startup backend engineer US',               techStack: ['nodejs', 'typescript'] },

  // ── Clay ─────────────────────────────────────────────────────────────────────
  { source: 'clay', keywords: 'saas startup nodejs typescript engineer US',         techStack: ['nodejs', 'typescript'] },
  { source: 'clay', keywords: 'ai ml startup python generative engineer US',        techStack: ['python', 'generative-ai', 'ai'] },
  { source: 'clay', keywords: 'fintech startup fullstack react engineer US',        techStack: ['react', 'nodejs', 'fullstack'] },
];

export function getAvailableSources(): Set<ScraperSource> {
  const available = new Set<ScraperSource>();

  available.add('wellfound');
  available.add('indeed');
  available.add('glassdoor');
  available.add('surelyremote');

  if (process.env['EXPLORIUM_API_KEY'])  available.add('explorium');
  if (process.env['APOLLO_API_KEY'])     available.add('apollo');
  if (process.env['CLAY_API_KEY'])       available.add('clay');
  if (process.env['CRUNCHBASE_API_KEY']) available.add('crunchbase');
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

const DISCOVERY_BACKLOG_THRESHOLD = parseInt(process.env['DISCOVERY_BACKLOG_THRESHOLD'] ?? '200', 10);

export function getSeedQueryCount(): number { return SEED_QUERIES.length; }

export async function enqueueSeedRound(label = 'scheduled'): Promise<{ runId: string; queries: number }> {
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
        attempts:         3,
        backoff:          { type: 'exponential', delay: 5000 },
        removeOnComplete: { count: 200 },
        removeOnFail:     { count: 100 },
      },
    );
  }

  logger.info({ runId, label, queued: activeQueries.length }, '[scheduler] Seed round enqueued');
  return { runId, queries: activeQueries.length };
}
