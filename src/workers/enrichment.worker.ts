import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { EnrichmentJobData } from '../types/index.js';
import { createWorker, queueManager, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { normalizer } from '../enrichment/normalizer.js';
import { indianRatioAnalyzer } from '../enrichment/dev-origin.analyzer.js';
import { githubScraper } from '../scrapers/github.scraper.js';
import { hunterScraper } from '../scrapers/hunter.scraper.js';
import { logger } from '../utils/logger.js';

async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
  const { runId, companyId, domain } = job.data;
  const startedAt = Date.now();

  logger.info({ runId, companyId, domain }, '[enrichment.worker] Job started');

  try {
    const company = await companyRepository.findById(companyId);
    if (!company) {
      logger.warn({ companyId, domain }, '[enrichment.worker] Company not found — skipping');
      return;
    }

    let contactsFound = 0;
    let jobsFound = 0;

    // ── 1. GitHub — tech stack + dev count ───────────────────────────────────
    logger.debug({ domain }, '[enrichment.worker] Starting GitHub enrichment');
    const githubResult = await githubScraper.enrichOrg(domain);
    if (githubResult?.company) {
      await companyRepository.upsert({
        ...githubResult.company,
        domain,
        name: company.name,
      });
      logger.info({ domain, techStack: githubResult.company.techStack }, '[enrichment.worker] GitHub data merged');
    }

    // ── 2. Hunter — email pattern + contacts ─────────────────────────────────
    logger.debug({ domain }, '[enrichment.worker] Starting Hunter enrichment');
    const hunterResult = await hunterScraper.enrichDomain(domain);
    if (hunterResult?.contacts?.length) {
      const { contacts } = normalizer.processResults([hunterResult]);
      for (const contact of contacts) {
        if (!contact.role) continue;
        const saved = await contactRepository.upsert({
          ...contact,
          companyId,
          fullName: contact.fullName ?? '',
          role: contact.role,
        });
        contactsFound++;
        logger.debug(
          { email: saved.email, role: saved.role, domain },
          '[enrichment.worker] Contact upserted from Hunter'
        );
      }
    }

    // ── 3. Dev Origin Ratio — analyse employee names from LinkedIn data ───────
    logger.debug({ domain, companyId }, '[enrichment.worker] Starting origin ratio analysis');
    const allContacts = await contactRepository.findByCompanyId(companyId);
    const nameList = allContacts
      .filter(c => c.fullName)
      .map(c => ({
        firstName: c.firstName,
        lastName:  c.lastName,
        fullName:  c.fullName,
      }));

    if (nameList.length >= parseInt(process.env['ORIGIN_RATIO_MIN_SAMPLE'] ?? '10')) {
      const ratioResult = await indianRatioAnalyzer.analyzeNames(nameList);
      logger.info(
        { domain, ratio: ratioResult.ratio, sample: ratioResult.totalCount, reliable: ratioResult.reliable },
        '[enrichment.worker] Origin ratio computed'
      );

      const threshold = parseFloat(process.env['ORIGIN_RATIO_THRESHOLD'] ?? '0.60');
      await companyRepository.upsert({
        domain,
        name: company.name,
        originDevCount: ratioResult.indianCount,
        totalDevCount:  ratioResult.totalCount,
        originRatio:    ratioResult.ratio,
        toleranceIncluded: ratioResult.ratio < 0.75 && ratioResult.ratio >= threshold,
      });
    } else {
      logger.debug(
        { domain, sample: nameList.length },
        '[enrichment.worker] Not enough employee names for origin analysis — skipping'
      );
    }

    // ── 4. Enqueue scoring ────────────────────────────────────────────────────
    await queueManager.addScoringJob({ runId, companyId });
    logger.info(
      { runId, companyId, domain, contactsFound, durationMs: Date.now() - startedAt },
      '[enrichment.worker] Job complete — scoring enqueued'
    );

  } catch (err) {
    logger.error({ err, runId, companyId, domain }, '[enrichment.worker] Job failed');
    throw err;
  }
}

export async function startEnrichmentWorker(): Promise<void> {
  await connectMongo();
  const worker = createWorker<EnrichmentJobData>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    3
  );
  logger.info('[enrichment.worker] Worker started');

  process.on('SIGTERM', async () => {
    logger.info('[enrichment.worker] SIGTERM received — shutting down');
    await worker.close();
    process.exit(0);
  });
}
