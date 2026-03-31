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
import { clearbitScraper } from '../scrapers/clearbit.scraper.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
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

    // ── Enrichment cooldown — skip full re-enrichment if done within 24h ────────
    const COOLDOWN_MS = 24 * 60 * 60 * 1000;
    if (company.lastEnrichedAt) {
      const ageMs = Date.now() - new Date(company.lastEnrichedAt).getTime();
      if (ageMs < COOLDOWN_MS) {
        logger.info(
          { domain, ageHours: (ageMs / 3_600_000).toFixed(1) },
          '[enrichment.worker] Recently enriched — skipping, queuing scoring only'
        );
        await queueManager.addScoringJob({ runId, companyId });
        return;
      }
    }

    let contactsFound = 0;

    // ── 1+2. GitHub + Clearbit in parallel ─────────────────────────────────────
    logger.debug({ domain }, '[enrichment.worker] GitHub + Clearbit in parallel');
    const [githubResult, clearbitResult] = await Promise.all([
      githubScraper.enrichOrg(domain),
      clearbitScraper.enrichDomain(domain).catch(err => {
        logger.warn({ err, domain }, '[enrichment.worker] Clearbit failed — continuing');
        return null;
      }),
    ]);

    if (githubResult?.company) {
      await companyRepository.upsert({ ...githubResult.company, domain, name: company.name });
      logger.info(
        { domain, techStack: githubResult.company.techStack },
        '[enrichment.worker] GitHub tech stack merged'
      );
    } else {
      logger.debug({ domain }, '[enrichment.worker] No GitHub org found');
    }

    if (clearbitResult?.company) {
      await companyRepository.upsert({ ...clearbitResult.company, domain, name: company.name });
      logger.info(
        { domain, employees: clearbitResult.company.employeeCount },
        '[enrichment.worker] Clearbit data merged'
      );
    } else {
      logger.debug({ domain }, '[enrichment.worker] No Clearbit data');
    }

    // Save GitHub contributor names as contacts (batch — used for origin ratio)
    if (githubResult?.contacts?.length) {
      const saveResults = await Promise.allSettled(
        githubResult.contacts
          .filter(c => c.fullName)
          .map(contact =>
            contactRepository.upsert({
              ...contact,
              companyId,
              fullName: contact.fullName!,
              role: contact.role ?? 'Unknown',
            })
          )
      );
      const saved = saveResults.filter(r => r.status === 'fulfilled').length;
      contactsFound += saved;
      logger.info({ domain, saved }, '[enrichment.worker] GitHub contributor names saved');
    }

    // ── 3. Hunter — email pattern discovery ────────────────────────────────────
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

    // ── 4. Contact Resolver — verify emails + fill missing CEO/HR ──────────────
    logger.debug({ domain, companyId }, '[enrichment.worker] Contact resolution');
    await contactResolver.resolveForCompany(companyId, domain).catch(err =>
      logger.error({ err, domain, companyId }, '[enrichment.worker] Contact resolution failed — continuing')
    );

    // ── 5. Dev Origin Ratio — analyse employee name list ───────────────────────
    logger.debug({ domain, companyId }, '[enrichment.worker] Origin ratio analysis');
    const allContacts = await contactRepository.findByCompanyId(companyId);
    const nameList = allContacts
      .filter(c => c.fullName)
      .map(c => ({ firstName: c.firstName, lastName: c.lastName, fullName: c.fullName }));

    const appSettings = await settingsRepository.get();
    const minSample   = appSettings.originRatioMinSample;
    const threshold   = appSettings.originRatioThreshold;

    if (nameList.length >= minSample) {
      const ratioResult = await devOriginAnalyzer.analyzeNames(nameList);
      logger.info(
        { domain, ratio: ratioResult.ratio, sample: ratioResult.totalCount, reliable: ratioResult.reliable },
        '[enrichment.worker] Origin ratio computed'
      );

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

    // ── 6. Stamp lastEnrichedAt + enqueue scoring ───────────────────────────────
    await companyRepository.upsert({ domain, name: company.name, lastEnrichedAt: new Date() });
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
