import { Company, Contact, Job } from '../types/index.js';
import { normalizeDomain } from '../utils/random.js';
import { logger } from '../utils/logger.js';

// ── Company Deduplication ──────────────────────────────────────────────────────

/**
 * Deduplicates a list of partial companies by domain.
 * When two records share a domain, merges them (union arrays, max numerics).
 * Returns one record per unique domain.
 */
export function deduplicateCompanies(companies: Partial<Company>[]): Partial<Company>[] {
  const seen = new Map<string, Partial<Company>>();

  for (const co of companies) {
    if (!co.domain) {
      logger.debug('[deduplicator] Skipping company with no domain');
      continue;
    }

    const key = normalizeDomain(co.domain);
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, { ...co, domain: key });
      continue;
    }

    // Merge into existing record
    seen.set(key, mergeCompanyRecords(existing, co));
    logger.debug({ domain: key }, '[deduplicator] Company merged');
  }

  const deduplicated = [...seen.values()];
  logger.info(
    { input: companies.length, output: deduplicated.length, deduped: companies.length - deduplicated.length },
    '[deduplicator] Companies deduplicated'
  );
  return deduplicated;
}

function mergeCompanyRecords(base: Partial<Company>, incoming: Partial<Company>): Partial<Company> {
  return {
    ...base,
    // Prefer non-null values from incoming
    name:            incoming.name ?? base.name,
    description:     incoming.description ?? base.description,
    linkedinUrl:     incoming.linkedinUrl ?? base.linkedinUrl,
    crunchbaseUrl:   incoming.crunchbaseUrl ?? base.crunchbaseUrl,
    websiteUrl:      incoming.websiteUrl ?? base.websiteUrl,
    githubOrg:       incoming.githubOrg ?? base.githubOrg,
    hqCountry:       incoming.hqCountry ?? base.hqCountry,
    hqCity:          incoming.hqCity ?? base.hqCity,
    hqState:         incoming.hqState ?? base.hqState,
    fundingStage:    incoming.fundingStage && incoming.fundingStage !== 'Unknown'
                       ? incoming.fundingStage
                       : base.fundingStage,
    foundedYear:     incoming.foundedYear ?? base.foundedYear,
    // Take max of numeric fields — use maxDefined() so 0 is preserved (0 ratio ≠ unknown)
    employeeCount:   maxDefined(base.employeeCount, incoming.employeeCount),
    fundingTotalUsd: maxDefined(base.fundingTotalUsd, incoming.fundingTotalUsd),
    originDevCount:  maxDefined(base.originDevCount, incoming.originDevCount),
    totalDevCount:   maxDefined(base.totalDevCount, incoming.totalDevCount),
    originRatio:     maxDefined(base.originRatio, incoming.originRatio),
    score:           Math.max(base.score ?? 0, incoming.score ?? 0),
    // Union arrays
    industry:        uniqueArray([...(base.industry ?? []), ...(incoming.industry ?? [])]),
    techStack:       uniqueArray([...(base.techStack ?? []), ...(incoming.techStack ?? [])]),
    openRoles:       uniqueArray([...(base.openRoles ?? []), ...(incoming.openRoles ?? [])]),
    sources:         uniqueArray([...(base.sources ?? []), ...(incoming.sources ?? [])]),
  };
}

/** Returns the larger of two numbers, preserving 0 as a valid value. Returns undefined only if both inputs are undefined. */
function maxDefined(a?: number, b?: number): number | undefined {
  if (a === undefined && b === undefined) return undefined;
  return Math.max(a ?? 0, b ?? 0);
}

// ── Contact Deduplication ─────────────────────────────────────────────────────

/**
 * Deduplicates contacts by email (primary), then by fullName + companyId.
 * Merges phone, LinkedIn, and confidence fields.
 */
export function deduplicateContacts(contacts: Partial<Contact>[]): Partial<Contact>[] {
  const byEmail = new Map<string, Partial<Contact>>();
  const byNameCompany = new Map<string, Partial<Contact>>();

  for (const c of contacts) {
    if (c.email) {
      const emailKey = c.email.toLowerCase().trim();
      const nameKey  = `${(c.fullName ?? '').toLowerCase().trim()}:${c.companyId ?? ''}`;

      // Merge with email map if email already seen
      const existingByEmail = byEmail.get(emailKey);
      if (existingByEmail) {
        byEmail.set(emailKey, mergeContactRecords(existingByEmail, c));
        logger.debug({ email: emailKey }, '[deduplicator] Contact merged by email');
      } else {
        // Check if this person was previously added without an email — promote and merge
        const existingByName = byNameCompany.get(nameKey);
        if (existingByName) {
          byEmail.set(emailKey, mergeContactRecords(existingByName, c));
          byNameCompany.delete(nameKey);
          logger.debug({ email: emailKey, name: c.fullName }, '[deduplicator] Contact promoted from name-map to email-map');
        } else {
          byEmail.set(emailKey, c);
        }
      }
    } else {
      // Fall back to name + companyId
      const key = `${(c.fullName ?? '').toLowerCase().trim()}:${c.companyId ?? ''}`;
      const existing = byNameCompany.get(key);
      if (!existing) {
        byNameCompany.set(key, c);
      } else {
        byNameCompany.set(key, mergeContactRecords(existing, c));
        logger.debug({ name: c.fullName }, '[deduplicator] Contact merged by name+company');
      }
    }
  }

  const deduplicated = [...byEmail.values(), ...byNameCompany.values()];
  logger.info(
    { input: contacts.length, output: deduplicated.length },
    '[deduplicator] Contacts deduplicated'
  );
  return deduplicated;
}

function mergeContactRecords(base: Partial<Contact>, incoming: Partial<Contact>): Partial<Contact> {
  return {
    ...base,
    phone:          incoming.phone ?? base.phone,
    linkedinUrl:    incoming.linkedinUrl ?? base.linkedinUrl,
    twitterUrl:     incoming.twitterUrl ?? base.twitterUrl,
    location:       incoming.location ?? base.location,
    emailVerified:  incoming.emailVerified || base.emailVerified,
    emailConfidence: Math.max(base.emailConfidence ?? 0, incoming.emailConfidence ?? 0),
    isIndianOrigin: incoming.isIndianOrigin ?? base.isIndianOrigin,
    sources:        uniqueArray([...(base.sources ?? []), ...(incoming.sources ?? [])]),
  };
}

// ── Job Deduplication ─────────────────────────────────────────────────────────

/**
 * Deduplicates jobs by companyId + normalised title.
 * Keeps the freshest postedAt and union-merges techTags.
 */
export function deduplicateJobs(jobs: Partial<Job>[]): Partial<Job>[] {
  const seen = new Map<string, Partial<Job>>();

  for (const job of jobs) {
    if (!job.title || !job.companyId) continue;
    const key = `${job.companyId}:${job.title.toLowerCase().trim()}`;
    const existing = seen.get(key);

    if (!existing) {
      seen.set(key, job);
    } else {
      seen.set(key, {
        ...existing,
        techTags: uniqueArray([...(existing.techTags ?? []), ...(job.techTags ?? [])]),
        // Prefer the more recent postedAt
        postedAt: newerDate(existing.postedAt, job.postedAt),
        isActive: existing.isActive || job.isActive,
      });
    }
  }

  const deduplicated = [...seen.values()];
  logger.info(
    { input: jobs.length, output: deduplicated.length },
    '[deduplicator] Jobs deduplicated'
  );
  return deduplicated;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function uniqueArray<T>(arr: T[]): T[] {
  return [...new Set(arr)];
}

function newerDate(a?: Date, b?: Date): Date | undefined {
  if (!a) return b;
  if (!b) return a;
  return a > b ? a : b;
}
