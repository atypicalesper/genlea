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
import {
  linkedInScraper, apolloScraper, crunchbaseScraper, wellfoundScraper,
  indeedScraper, zoomInfoScraper, glassdoorScraper, surelyRemoteScraper,
} from '../scrapers/discovery/index.js';
import { deduplicateCompanies } from '../enrichment/deduplicator.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { logger } from '../utils/logger.js';
import { generateRunId } from '../utils/random.js';

// ── Enterprise blocklist — never valid leads ──────────────────────────────────
const BLOCKED_DOMAINS = new Set([
  // Big Tech
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
  // Banks & Financial institutions
  'jpmorganchase.com', 'jpmorgan.com', 'chase.com',
  'bankofamerica.com', 'wellsfargo.com', 'citigroup.com', 'citi.com',
  'goldmansachs.com', 'morganstanley.com', 'ubs.com', 'barclays.com',
  'hsbc.com', 'deutschebank.com', 'creditsuisse.com', 'bnpparibas.com',
  'capitalone.com', 'usbank.com', 'pnc.com', 'tdbank.com', 'truist.com',
  'americanexpress.com', 'visa.com', 'mastercard.com', 'discover.com',
  'blackrock.com', 'vanguard.com', 'fidelity.com', 'schwab.com',
  // Consulting & Professional Services
  'mckinsey.com', 'bcg.com', 'bain.com', 'deloitte.com', 'pwc.com',
  'kpmg.com', 'ey.com', 'accenture.com', 'capgemini.com', 'infosys.com',
  'tcs.com', 'wipro.com', 'cognizant.com', 'hcl.com', 'tech-mahindra.com',
  // Telecom & Media
  'att.com', 'verizon.com', 't-mobile.com', 'comcast.com', 'charter.com',
  'disney.com', 'warnermedia.com', 'nbcuniversal.com', 'foxcorporation.com',
  // Healthcare & Insurance
  'unitedhealthgroup.com', 'anthem.com', 'aetna.com', 'humana.com', 'cigna.com',
  'johnsonandjohnson.com', 'abbvie.com', 'pfizer.com', 'merck.com', 'lilly.com',
  // Retail & CPG
  'walmart.com', 'target.com', 'costco.com', 'homedepot.com', 'lowes.com',
  'nike.com', 'adidas.com', 'pg.com', 'unilever.com', 'nestle.com',
  // Other large enterprises
  'boeing.com', 'lockheedmartin.com', 'raytheon.com', 'generaldynamics.com',
  'ge.com', 'honeywell.com', 'siemens.com', 'caterpillar.com', 'ford.com',
  'gm.com', 'tesla.com', 'toyota.com',
]);

// ── Target country allowlist — only companies HQ'd in developed markets ──────
// ISO 3166-1 alpha-2 codes + common free-text variants scrapers may return
const ALLOWED_COUNTRIES = new Set([
  'US', 'USA', 'UNITED STATES', 'UNITED STATES OF AMERICA',
  'GB', 'UK', 'UNITED KINGDOM', 'ENGLAND', 'SCOTLAND', 'WALES',
  'CA', 'CANADA',
  'AU', 'AUSTRALIA',
  'NZ', 'NEW ZEALAND',
  'IE', 'IRELAND',
  'SG', 'SINGAPORE',
  'DE', 'GERMANY',
  'FR', 'FRANCE',
  'NL', 'NETHERLANDS', 'HOLLAND',
  'SE', 'SWEDEN',
  'NO', 'NORWAY',
  'DK', 'DENMARK',
  'FI', 'FINLAND',
  'CH', 'SWITZERLAND',
  'AT', 'AUSTRIA',
  'BE', 'BELGIUM',
  'ES', 'SPAIN',
  'IT', 'ITALY',
  'PT', 'PORTUGAL',
  'PL', 'POLAND',
  'CZ', 'CZECH REPUBLIC', 'CZECHIA',
  'HU', 'HUNGARY',
  'RO', 'ROMANIA',
  'IL', 'ISRAEL',
  'EE', 'ESTONIA',
  'LV', 'LATVIA',
  'LT', 'LITHUANIA',
]);

// ── Name-based large-enterprise keyword filter ────────────────────────────────
// Catches big companies that slip through without a known domain or employee count
const BLOCKED_NAME_PATTERNS = [
  /\bbank\b/i, /\bchase\b/i, /\bmorgan\b/i, /\bfinancial\b/i,
  /\binsurance\b/i, /\bhospital\b/i, /\bhealthcare\b/i, /\bhealth system\b/i,
  /\bdeloitte\b/i, /\baccenture\b/i, /\bcognizant\b/i, /\binfosys\b/i,
  /\bwipro\b/i, /\btata consultancy\b/i, /\btech mahindra\b/i,
  /\bwalmart\b/i, /\bamazon\b/i, /\bmicrosoft\b/i, /\bgoogle\b/i,
  /\bgovernment\b/i, /\bfederal\b/i, /\bdepartment of\b/i,
];

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
      }).catch(e => logger.warn({ e }, '[discovery.worker] Could not write skipped log'));
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

      // Skip companies with no tech signal at all — not a target
      const hasTech = (company.techStack?.length ?? 0) > 0;
      const rawForCheck = domainToRaw.get(company.domain) ?? [];
      const hasTechJobs = rawForCheck.some(r =>
        r.jobs?.some(j => j.techTags && j.techTags.length > 0)
      );
      if (!hasTech && !hasTechJobs) {
        logger.debug({ domain: company.domain }, '[discovery.worker] No tech signal — skipping');
        continue;
      }

      // Skip known large enterprises — they will never be valid leads
      if (BLOCKED_DOMAINS.has(company.domain)) {
        logger.debug({ domain: company.domain }, '[discovery.worker] Blocked enterprise domain — skipping');
        continue;
      }

      // Skip companies explicitly HQ'd outside target markets
      if (company.hqCountry) {
        const countryKey = company.hqCountry.trim().toUpperCase();
        if (!ALLOWED_COUNTRIES.has(countryKey)) {
          logger.debug({ domain: company.domain, hqCountry: company.hqCountry }, '[discovery.worker] Non-target country — skipping');
          continue;
        }
      }

      // Skip by name pattern (catches large enterprises without a known domain)
      if (company.name && BLOCKED_NAME_PATTERNS.some(re => re.test(company.name!))) {
        logger.debug({ domain: company.domain, name: company.name }, '[discovery.worker] Blocked enterprise name pattern — skipping');
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

        // ── Save contacts & jobs from raw scraper output (all in parallel) ───
        const rawForDomain = domainToRaw.get(saved.domain) ?? [];
        const contactSaves: Promise<unknown>[] = [];
        const jobSaves:     Promise<unknown>[] = [];

        for (const raw of rawForDomain) {
          for (const rawContact of raw.contacts ?? []) {
            const contact = normalizer.normalizeContact(rawContact, raw.source);
            if (!contact?.fullName) continue;
            contactSaves.push(
              contactRepository.upsert({
                ...contact,
                companyId: saved._id!,
                fullName:  contact.fullName,
                role:      contact.role ?? 'Unknown',
              }).catch(err => logger.debug({ err, domain: saved.domain }, '[discovery.worker] Contact dupe — skipped'))
            );
          }

          for (const rawJob of raw.jobs ?? []) {
            const j = normalizer.normalizeJob(rawJob, raw.source);
            if (!j?.title) continue;
            jobSaves.push(
              jobRepository.upsert({
                ...j,
                companyId: saved._id!,
                title:     j.title,
              }).catch(err => errors.push(`job:${saved.domain}:${err instanceof Error ? err.message : String(err)}`))
            );
          }
        }

        await Promise.allSettled([...contactSaves, ...jobSaves]);
        contactsFound += contactSaves.length;
        jobsFound     += jobSaves.length;

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
  const initialSettings = await settingsRepository.get();
  const worker = createWorker<DiscoveryJobData>(
    QUEUE_NAMES.DISCOVERY,
    processDiscoveryJob,
    initialSettings.workerConcurrencyDiscovery,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyDiscovery }, '[discovery.worker] Worker started');

  setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyDiscovery;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[discovery.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[discovery.worker] SIGTERM received — shutting down');
    await worker.close();
    process.exit(0);
  });
}
