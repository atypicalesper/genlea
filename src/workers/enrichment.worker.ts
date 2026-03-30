import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { EnrichmentJobData } from '../types/index.js';
import { createWorker, queueManager, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { normalizer } from '../enrichment/normalizer.js';
import { indianRatioAnalyzer as devOriginAnalyzer } from '../enrichment/dev-origin.analyzer.js';
import { contactResolver } from '../enrichment/contact.resolver.js';
import { deduplicateContacts } from '../enrichment/deduplicator.js';
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

    // ── 1. GitHub — tech stack + contributor names ──────────────────────────────
    logger.debug({ domain }, '[enrichment.worker] GitHub enrichment');
    const githubResult = await githubScraper.enrichOrg(domain);
    if (githubResult?.company) {
      await companyRepository.upsert({ ...githubResult.company, domain, name: company.name });
      logger.info(
        { domain, techStack: githubResult.company.techStack },
        '[enrichment.worker] GitHub tech stack merged'
      );
    } else {
      logger.debug({ domain }, '[enrichment.worker] No GitHub org found');
    }

    // Save GitHub contributor names as contacts (used for origin ratio)
    if (githubResult?.contacts?.length) {
      for (const contact of githubResult.contacts) {
        if (!contact.fullName) continue;
        await contactRepository.upsert({
          ...contact,
          companyId,
          fullName: contact.fullName,
          role: contact.role ?? 'Unknown',
        }).catch(() => {}); // ignore dupes
      }
      logger.info(
        { domain, count: githubResult.contacts.length },
        '[enrichment.worker] GitHub contributor names saved'
      );
      contactsFound += githubResult.contacts.length;
    }

    // ── 2. Hunter — email pattern discovery ────────────────────────────────────
    logger.debug({ domain }, '[enrichment.worker] Hunter email discovery');
    const hunterResult = await hunterScraper.enrichDomain(domain);
    if (hunterResult?.contacts?.length) {
      const { contacts: rawContacts } = normalizer.processResults([hunterResult]);
      const dedupedContacts = deduplicateContacts(rawContacts);

      for (const contact of dedupedContacts) {
        if (!contact.role) continue;
        const saved = await contactRepository.upsert({
          ...contact,
          companyId,
          fullName: contact.fullName ?? '',
          role:     contact.role,
        });
        contactsFound++;
        logger.debug(
          { email: saved.email, role: saved.role, confidence: saved.emailConfidence },
          '[enrichment.worker] Hunter contact upserted'
        );
      }
    } else {
      logger.debug({ domain }, '[enrichment.worker] No Hunter results');
    }

    // ── 3. Contact Resolver — verify emails + fill missing CEO/HR ──────────────
    logger.debug({ domain, companyId }, '[enrichment.worker] Contact resolution');
    await contactResolver.resolveForCompany(companyId, domain);

    // ── 4. Dev Origin Ratio — analyse employee name list ───────────────────────
    logger.debug({ domain, companyId }, '[enrichment.worker] Origin ratio analysis');
    const allContacts = await contactRepository.findByCompanyId(companyId);
    const nameList = allContacts
      .filter(c => c.fullName)
      .map(c => ({ firstName: c.firstName, lastName: c.lastName, fullName: c.fullName }));

    const minSample = parseInt(process.env['ORIGIN_RATIO_MIN_SAMPLE'] ?? '10');
    if (nameList.length >= minSample) {
      const ratioResult = await devOriginAnalyzer.analyzeNames(nameList);
      logger.info(
        {
          domain,
          ratio:    ratioResult.ratio,
          sample:   ratioResult.totalCount,
          reliable: ratioResult.reliable,
        },
        '[enrichment.worker] Origin ratio computed'
      );

      const threshold = parseFloat(process.env['ORIGIN_RATIO_THRESHOLD'] ?? '0.60');
      await companyRepository.upsert({
        domain,
        name:              company.name,
        originDevCount:    ratioResult.indianCount,
        totalDevCount:     ratioResult.totalCount,
        originRatio:       ratioResult.ratio,
        toleranceIncluded: ratioResult.ratio < 0.75 && ratioResult.ratio >= threshold,
      });
    } else {
      logger.debug(
        { domain, sample: nameList.length, required: minSample },
        '[enrichment.worker] Insufficient sample for origin analysis'
      );
    }

    // ── 5. Enqueue scoring ──────────────────────────────────────────────────────
    await queueManager.addScoringJob({ runId, companyId });

    const durationMs = Date.now() - startedAt;
    logger.info(
      { runId, companyId, domain, contactsFound, durationMs },
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
    3 // 3 concurrent enrichment jobs
  );
  logger.info('[enrichment.worker] Worker started — listening for enrichment jobs');

  process.on('SIGTERM', async () => {
    logger.info('[enrichment.worker] SIGTERM received — draining and shutting down');
    await worker.close();
    process.exit(0);
  });
}
