import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { DiscoveryJobData, ScrapeQuery } from '../types/index.js';
import { createWorker, queueManager, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { scrapeLogRepository } from '../storage/repositories/scrape-log.repository.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { normalizer } from '../enrichment/normalizer.js';
import { linkedInScraper } from '../scrapers/linkedin.scraper.js';
import { apolloScraper } from '../scrapers/apollo.scraper.js';
import { crunchbaseScraper } from '../scrapers/crunchbase.scraper.js';
import { logger } from '../utils/logger.js';
import { generateRunId } from '../utils/random.js';

const SCRAPERS = {
  linkedin:   linkedInScraper,
  apollo:     apolloScraper,
  crunchbase: crunchbaseScraper,
};

async function processDiscoveryJob(job: Job<DiscoveryJobData>): Promise<void> {
  const { runId, source, query } = job.data;
  const startedAt = new Date();
  const logId = (await scrapeLogRepository.create({
    runId, scraper: source, status: 'processing',
    companiesFound: 0, contactsFound: 0, jobsFound: 0,
    errors: [], durationMs: 0, startedAt,
  }))._id!;

  logger.info({ runId, source, query: query.keywords }, '[discovery.worker] Job started');

  const errors: string[] = [];
  let companiesFound = 0;

  try {
    const scraper = SCRAPERS[source as keyof typeof SCRAPERS];
    if (!scraper) throw new Error(`Unknown scraper source: ${source}`);

    const available = await scraper.isAvailable();
    if (!available) {
      logger.warn({ source, runId }, '[discovery.worker] Scraper not available — skipping');
      throw new Error(`Scraper ${source} is not available (missing credentials?)`);
    }

    // ── Run scraper ─────────────────────────────────────────────────────────
    logger.info({ source, runId }, '[discovery.worker] Invoking scraper');
    const rawResults = await scraper.scrape(query);
    logger.info({ source, runId, rawCount: rawResults.length }, '[discovery.worker] Raw results received');

    // ── Normalize ───────────────────────────────────────────────────────────
    const { companies } = normalizer.processResults(rawResults);
    logger.info({ source, runId, normalized: companies.length }, '[discovery.worker] Normalized companies');

    // ── Upsert companies + enqueue enrichment ───────────────────────────────
    for (const company of companies) {
      if (!company.domain || !company.name) {
        logger.warn({ company }, '[discovery.worker] Skipping company with missing domain/name');
        continue;
      }

      try {
        const saved = await companyRepository.upsert(
          company as Parameters<typeof companyRepository.upsert>[0]
        );

        companiesFound++;
        logger.debug(
          { domain: saved.domain, id: saved._id },
          '[discovery.worker] Company upserted — queuing enrichment'
        );

        await queueManager.addEnrichmentJob({
          runId,
          companyId: saved._id!,
          domain: saved.domain,
          sources: ['github', 'hunter', 'clearbit'],
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`upsert:${company.domain}:${msg}`);
        logger.error({ err, domain: company.domain }, '[discovery.worker] Upsert failed');
      }
    }

    const durationMs = Date.now() - startedAt.getTime();
    await scrapeLogRepository.complete(logId, {
      status: errors.length > 0 ? 'partial' : 'success',
      companiesFound,
      contactsFound: 0,
      jobsFound: 0,
      errors,
      durationMs,
    });

    logger.info(
      { runId, source, companiesFound, durationMs, errors: errors.length },
      '[discovery.worker] Job complete'
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    const durationMs = Date.now() - startedAt.getTime();
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound, contactsFound: 0, jobsFound: 0, errors, durationMs,
    }).catch(e => logger.error({ e }, '[discovery.worker] Could not write failure log'));

    logger.error({ err, runId, source }, '[discovery.worker] Job failed');
    throw err; // let BullMQ handle retry
  }
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────
export async function startDiscoveryWorker(): Promise<void> {
  await connectMongo();
  const worker = createWorker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    processDiscoveryJob,
    2 // max 2 concurrent discovery jobs
  );
  logger.info('[discovery.worker] Worker started');

  process.on('SIGTERM', async () => {
    logger.info('[discovery.worker] SIGTERM received — shutting down');
    await worker.close();
    process.exit(0);
  });
}
