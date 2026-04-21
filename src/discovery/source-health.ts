import { scrapeLogRepository } from '../storage/repositories/scrape-log.repository.js';
import { logger }              from '../utils/logger.js';
import type { ScraperSource }  from '../types/index.js';

const ZERO_THRESHOLD  = parseInt(process.env['SOURCE_ZERO_THRESHOLD']     ?? '10', 10);
const MUTE_HOURS      = parseInt(process.env['SOURCE_MUTE_HOURS']         ?? '24', 10);
const HYDRATE_SOURCES: ScraperSource[] = [
  'wellfound', 'indeed', 'glassdoor', 'surelyremote',
  'greenhouse', 'lever', 'ashby', 'workable',
  'explorium', 'crunchbase', 'apollo', 'zoominfo', 'clay', 'linkedin',
];

type Health = { consecutiveZeros: number; mutedUntil?: Date };

const health = new Map<ScraperSource, Health>();

function get(source: ScraperSource): Health {
  let h = health.get(source);
  if (!h) { h = { consecutiveZeros: 0 }; health.set(source, h); }
  return h;
}

export function recordResult(source: ScraperSource, companiesFound: number): void {
  const h = get(source);
  if (companiesFound > 0) {
    if (h.consecutiveZeros > 0) {
      logger.debug({ source, prevZeros: h.consecutiveZeros }, '[source-health] Recovered');
    }
    h.consecutiveZeros = 0;
    delete h.mutedUntil;
    return;
  }

  h.consecutiveZeros++;
  if (h.consecutiveZeros >= ZERO_THRESHOLD && !h.mutedUntil) {
    h.mutedUntil = new Date(Date.now() + MUTE_HOURS * 3600_000);
    logger.warn(
      { source, zeros: h.consecutiveZeros, threshold: ZERO_THRESHOLD, mutedUntil: h.mutedUntil },
      '[source-health] Muting source — too many consecutive empty responses',
    );
  }
}

export function isMuted(source: ScraperSource): boolean {
  const h = health.get(source);
  if (!h?.mutedUntil) return false;
  if (h.mutedUntil.getTime() <= Date.now()) {
    delete h.mutedUntil;
    h.consecutiveZeros = 0;
    logger.info({ source }, '[source-health] Unmuting — cooldown elapsed');
    return false;
  }
  return true;
}

export function getHealthSnapshot(): Array<{ source: ScraperSource; consecutiveZeros: number; mutedUntil?: Date }> {
  return [...health.entries()].map(([source, h]) => ({
    source,
    consecutiveZeros: h.consecutiveZeros,
    mutedUntil:       h.mutedUntil,
  }));
}

export async function hydrateSourceHealth(): Promise<void> {
  await Promise.all(HYDRATE_SOURCES.map(async source => {
    try {
      const logs = await scrapeLogRepository.findRecent(source, ZERO_THRESHOLD);
      let zeros = 0;
      for (const log of logs) {
        if (log.status === 'processing') continue;
        if ((log.companiesFound ?? 0) === 0) zeros++;
        else break;
      }
      if (zeros === 0) return;

      const h = get(source);
      h.consecutiveZeros = zeros;
      if (zeros >= ZERO_THRESHOLD) {
        const last = logs[0]?.completedAt ?? logs[0]?.startedAt ?? new Date();
        const until = new Date(last.getTime() + MUTE_HOURS * 3600_000);
        if (until.getTime() > Date.now()) h.mutedUntil = until;
      }
    } catch (err) {
      logger.debug({ err, source }, '[source-health] Hydrate failed');
    }
  }));

  const muted = getHealthSnapshot().filter(s => s.mutedUntil);
  logger.info({ muted, threshold: ZERO_THRESHOLD, muteHours: MUTE_HOURS }, '[source-health] Hydrated from scrape_logs');
}
