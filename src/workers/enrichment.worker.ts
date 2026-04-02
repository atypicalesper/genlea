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
import { githubScraper, hunterScraper, clearbitScraper } from '../scrapers/enrichment/index.js';
import { websiteTeamScraper } from '../enrichment/website-team.enricher.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import axios from 'axios';
import { logger } from '../utils/logger.js';

// ── Defunct/shutdown company signals ─────────────────────────────────────────
const DEFUNCT_HTML_PATTERNS = [
  /domain\s+(is\s+)?for\s+sale/i,
  /this\s+domain\s+has\s+(expired|been\s+suspended)/i,
  /account\s+suspended/i,
  /site\s+(is\s+)?coming\s+soon/i,
  /under\s+construction/i,
  /parked\s+(free\s+)?by\s+/i,
  /buy\s+this\s+domain/i,
  /this\s+page\s+(is\s+)?intentionally\s+left\s+blank/i,
  /company\s+(has\s+)?(closed|shut\s+down|ceased\s+operations)/i,
  /we\s+(are\s+|have\s+)?shut(ting)?\s+down/i,
  /no\s+longer\s+in\s+(business|operation)/i,
];

async function isDefunct(domain: string, websiteUrl?: string): Promise<boolean> {
  const url = websiteUrl || `https://${domain}`;
  try {
    const res = await axios.get<string>(url, {
      timeout: 8000,
      maxRedirects: 3,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Googlebot/2.1)' },
      validateStatus: () => true, // don't throw on 4xx/5xx
    });
    // Hard 404 on the root domain — almost certainly dead
    if (res.status === 404) return true;
    const html = typeof res.data === 'string' ? res.data : '';
    return DEFUNCT_HTML_PATTERNS.some(re => re.test(html));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code ?? '';
    // DNS failure or connection refused = domain is dead
    return ['ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET'].includes(code);
  }
}

async function processEnrichmentJob(job: Job<EnrichmentJobData>): Promise<void> {
  const { runId, companyId, domain, force } = job.data;
  const startedAt = Date.now();

  logger.info({ runId, companyId, domain, force }, '[enrichment.worker] Job started');

  try {
    const company = await companyRepository.findById(companyId);
    if (!company) {
      logger.warn({ companyId, domain }, '[enrichment.worker] Company not found — skipping');
      return;
    }

    // ── Size guard — disqualify oversized companies immediately ─────────────────
    if (company.employeeCount && company.employeeCount > 1000) {
      logger.info({ domain, employees: company.employeeCount }, '[enrichment.worker] Too large — disqualifying, skipping enrichment');
      await companyRepository.disqualify(companyId);
      return;
    }

    // ── Enrichment cooldown — skip full re-enrichment if done within 24h ────────
    // Bypass with force=true (set by manual /api/companies/:id/enrich trigger)
    const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — manual force=true to bypass
    if (!force && company.lastEnrichedAt) {
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

    // ── 3. Website team page — free name source, no API key ────────────────────
    const websiteUrl = company.websiteUrl;
    if (websiteUrl) {
      logger.debug({ domain, websiteUrl }, '[enrichment.worker] Scraping website team page');
      const teamMembers = await websiteTeamScraper.scrapeTeam(websiteUrl, domain).catch(err => {
        logger.warn({ err, domain }, '[enrichment.worker] Website team scrape failed — continuing');
        return [];
      });
      if (teamMembers.length > 0) {
        const saveResults = await Promise.allSettled(
          teamMembers.map(person =>
            contactRepository.upsert({
              companyId,
              fullName:    person.fullName,
              firstName:   person.fullName.split(' ')[0],
              lastName:    person.fullName.split(' ').at(-1),
              role:        'Unknown',
              linkedinUrl: person.linkedinUrl,
              email:       person.email,
              sources:     ['website'],
            })
          )
        );
        const saved = saveResults.filter(r => r.status === 'fulfilled').length;
        contactsFound += saved;
        logger.info({ domain, saved }, '[enrichment.worker] Website team members saved');
      }
    }

    // ── 3b. Defunct check — disqualify dead/shutdown companies ─────────────────
    const defunct = await isDefunct(domain, company.websiteUrl).catch(() => false);
    if (defunct) {
      logger.info({ domain }, '[enrichment.worker] Company appears defunct — disqualifying');
      await companyRepository.disqualify(companyId);
      return;
    }

    // ── 4. Hunter — email pattern discovery ────────────────────────────────────
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

    // ── 5. Contact Resolver — verify emails + fill missing CEO/HR ──────────────
    logger.debug({ domain, companyId }, '[enrichment.worker] Contact resolution');
    await contactResolver.resolveForCompany(companyId, domain).catch(err =>
      logger.error({ err, domain, companyId }, '[enrichment.worker] Contact resolution failed — continuing')
    );

    // ── 6. Dev Origin Ratio — analyse employee name list ───────────────────────
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

    // ── 7. Stamp lastEnrichedAt + enqueue scoring ───────────────────────────────
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
  const initialSettings = await settingsRepository.get();
  const worker = createWorker<EnrichmentJobData>(
    QUEUE_NAMES.ENRICHMENT,
    processEnrichmentJob,
    initialSettings.workerConcurrencyEnrichment,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyEnrichment }, '[enrichment.worker] Worker started — listening for enrichment jobs');

  setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyEnrichment;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[enrichment.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[enrichment.worker] SIGTERM received — draining and shutting down');
    await worker.close();
    process.exit(0);
  });
}
