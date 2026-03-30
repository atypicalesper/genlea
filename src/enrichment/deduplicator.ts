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
    hqCity:          incoming.hqCity ?? base.hqCity,
    hqState:         incoming.hqState ?? base.hqState,
    fundingStage:    incoming.fundingStage && incoming.fundingStage !== 'Unknown'
                       ? incoming.fundingStage
                       : base.fundingStage,
    // Take max of numeric fields (latest/most-complete value wins)
    employeeCount:   Math.max(base.employeeCount ?? 0, incoming.employeeCount ?? 0) || undefined,
    fundingTotalUsd: Math.max(base.fundingTotalUsd ?? 0, incoming.fundingTotalUsd ?? 0) || undefined,
    originDevCount:  Math.max(base.originDevCount ?? 0, incoming.originDevCount ?? 0) || undefined,
    totalDevCount:   Math.max(base.totalDevCount ?? 0, incoming.totalDevCount ?? 0) || undefined,
    originRatio:     Math.max(base.originRatio ?? 0, incoming.originRatio ?? 0) || undefined,
    score:           Math.max(base.score ?? 0, incoming.score ?? 0),
    // Union arrays
    industry:        uniqueArray([...(base.industry ?? []), ...(incoming.industry ?? [])]),
    techStack:       uniqueArray([...(base.techStack ?? []), ...(incoming.techStack ?? [])]),
    openRoles:       uniqueArray([...(base.openRoles ?? []), ...(incoming.openRoles ?? [])]),
    sources:         uniqueArray([...(base.sources ?? []), ...(incoming.sources ?? [])]),
  };
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
      const key = c.email.toLowerCase().trim();
      const existing = byEmail.get(key);
      if (!existing) {
        byEmail.set(key, c);
      } else {
        byEmail.set(key, mergeContactRecords(existing, c));
        logger.debug({ email: key }, '[deduplicator] Contact merged by email');
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
