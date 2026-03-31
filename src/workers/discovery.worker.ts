import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { DiscoveryJobData, ScrapeQuery } from '../types/index.js';
import { createWorker, queueManager, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { scrapeLogRepository } from '../storage/repositories/scrape-log.repository.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { normalizer } from '../enrichment/normalizer.js';
import { normalizeDomain } from '../utils/random.js';
import { linkedInScraper } from '../scrapers/linkedin.scraper.js';
import { apolloScraper } from '../scrapers/apollo.scraper.js';
import { crunchbaseScraper } from '../scrapers/crunchbase.scraper.js';
import { wellfoundScraper } from '../scrapers/wellfound.scraper.js';
import { indeedScraper } from '../scrapers/indeed.scraper.js';
import { zoomInfoScraper } from '../scrapers/zoominfo.scraper.js';
import { glassdoorScraper } from '../scrapers/glassdoor.scraper.js';
import { surelyRemoteScraper } from '../scrapers/surelyremote.scraper.js';
import { deduplicateCompanies } from '../enrichment/deduplicator.js';
import { logger } from '../utils/logger.js';
import { generateRunId } from '../utils/random.js';

// ── Enterprise blocklist — never valid leads ──────────────────────────────────
const BLOCKED_DOMAINS = new Set([
  'google.com', 'amazon.com', 'microsoft.com', 'apple.com', 'meta.com',
  'facebook.com', 'netflix.com', 'salesforce.com', 'oracle.com', 'ibm.com',
  'sap.com', 'adobe.com', 'intuit.com', 'paypal.com', 'ebay.com',
  'uber.com', 'lyft.com', 'airbnb.com', 'twitter.com', 'x.com',
  'linkedin.com', 'snap.com', 'pinterest.com', 'reddit.com', 'discord.com',
  'shopify.com', 'squarespace.com', 'wix.com', 'hubspot.com', 'zendesk.com',
  'atlassian.com', 'slack.com', 'zoom.us', 'dropbox.com', 'box.com',
  'twilio.com', 'cloudflare.com', 'okta.com', 'datadog.com', 'splunk.com',
  'crowdstrike.com', 'pagerduty.com', 'hashicorp.com', 'confluent.io',
  'stripe.com', 'plaid.com', 'braintree.com', 'square.com',
]);

const SCRAPERS = {
  linkedin:   linkedInScraper,
  apollo:     apolloScraper,
  crunchbase: crunchbaseScraper,
  wellfound:  wellfoundScraper,
  indeed:     indeedScraper,
  zoominfo:   zoomInfoScraper,
  glassdoor:     glassdoorScraper,
  surelyremote:  surelyRemoteScraper,
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
  let contactsFound  = 0;
  let jobsFound      = 0;

  try {
    const scraper = SCRAPERS[source as keyof typeof SCRAPERS];
    if (!scraper) throw new Error(`Unknown scraper source: ${source}`);

    const available = await scraper.isAvailable();
    if (!available) {
      logger.warn({ source, runId }, '[discovery.worker] Scraper not available — skipping gracefully');
      await scrapeLogRepository.complete(logId, {
        status: 'skipped',
        companiesFound: 0, contactsFound: 0, jobsFound: 0,
        errors: [`Scraper ${source} unavailable — missing credentials`],
        durationMs: Date.now() - startedAt.getTime(),
      }).catch(() => {});
      return; // complete job without retry
    }

    // ── Run scraper ─────────────────────────────────────────────────────────
    logger.info({ source, runId }, '[discovery.worker] Invoking scraper');
    const rawResults = await scraper.scrape(query);
    logger.info({ source, runId, rawCount: rawResults.length }, '[discovery.worker] Raw results received');

    // ── Build domain → raw results index (for jobs/contacts linkage) ─────────
    const domainToRaw = new Map<string, typeof rawResults>();
    for (const result of rawResults) {
      if (!result.company?.domain) continue;
      const d = normalizeDomain(result.company.domain);
      if (!d) continue;
      const existing = domainToRaw.get(d) ?? [];
      existing.push(result);
      domainToRaw.set(d, existing);
    }

    // ── Normalize + Deduplicate ──────────────────────────────────────────────
    const { companies } = normalizer.processResults(rawResults);
    const dedupedCompanies = deduplicateCompanies(companies);
    logger.info(
      { source, runId, raw: companies.length, deduped: dedupedCompanies.length },
      '[discovery.worker] Normalized + deduped'
    );

    // ── Upsert companies + save jobs/contacts + enqueue enrichment ───────────
    for (const company of dedupedCompanies) {
      if (!company.domain || !company.name) {
        logger.warn({ company }, '[discovery.worker] Skipping company with missing domain/name');
        continue;
      }

      // Skip known large enterprises — they will never be valid leads
      if (BLOCKED_DOMAINS.has(company.domain)) {
        logger.debug({ domain: company.domain }, '[discovery.worker] Blocked enterprise domain — skipping');
        continue;
      }

      // Skip if employee count already disqualifies company fit (>1000 = never a target)
      if (company.employeeCount && company.employeeCount > 1000) {
        logger.debug({ domain: company.domain, employees: company.employeeCount }, '[discovery.worker] Too large — skipping');
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

        // ── Save contacts & jobs from raw scraper output ────────────────────
        const rawForDomain = domainToRaw.get(saved.domain) ?? [];
        for (const raw of rawForDomain) {
          for (const rawContact of raw.contacts ?? []) {
            const contact = normalizer.normalizeContact(rawContact, raw.source);
            if (!contact?.fullName) continue;
            await contactRepository.upsert({
              ...contact,
              companyId: saved._id!,
              fullName:  contact.fullName,
              role:      contact.role ?? 'Unknown',
            }).catch(() => {}); // ignore dupes
            contactsFound++;
          }

          for (const rawJob of raw.jobs ?? []) {
            const j = normalizer.normalizeJob(rawJob, raw.source);
            if (!j?.title) continue;
            await jobRepository.upsert({
              ...j,
              companyId: saved._id!,
              title:     j.title,
            }).catch((err) => {
              errors.push(`job:${saved.domain}:${err instanceof Error ? err.message : String(err)}`);
            });
            jobsFound++;
          }
        }

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
      contactsFound,
      jobsFound,
      errors,
      durationMs,
    });

    logger.info(
      { runId, source, companiesFound, contactsFound, jobsFound, durationMs, errors: errors.length },
      '[discovery.worker] Job complete'
    );

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    const durationMs = Date.now() - startedAt.getTime();
    await scrapeLogRepository.complete(logId, {
      status: 'failed', companiesFound, contactsFound, jobsFound, errors, durationMs,
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
