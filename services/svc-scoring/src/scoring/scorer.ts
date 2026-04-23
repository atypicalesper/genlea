import type { ScoringInput, ScoringResult, ScoreBreakdown } from '@genlea/shared';
import { logger } from '@genlea/shared';
import {
  originRatioScore,
  jobFreshnessScore,
  techStackScore,
  contactScore,
  companyFitScore,
  getActiveEngineeringJobs,
} from './rules.js';
import { resolveStatus } from './status-resolver.js';

const HIRING_SOURCE_SET = new Set([
  'linkedin',
  'wellfound',
  'indeed',
  'glassdoor',
  'surelyremote',
  'greenhouse',
  'lever',
  'ashby',
  'workable',
]);
const MAX_TARGET_EMPLOYEES = 1000;
const MAX_TARGET_DEVS = 250;

export function scoreCompany(
  input: ScoringInput,
  thresholds?: {
    hotVerified?: number; hot: number; warm: number; cold?: number;
    targetTechTags?: string[]; highValueIndustries?: string[];
  }
): ScoringResult {
  const { company, contacts, jobs } = input;

  const breakdown: ScoreBreakdown = {
    originRatioScore:  originRatioScore(company),
    jobFreshnessScore: jobFreshnessScore(jobs),
    techStackScore:    techStackScore(company, jobs, thresholds?.targetTechTags),
    contactScore:      contactScore(contacts),
    companyFitScore:   companyFitScore(company, thresholds?.highValueIndustries),
    total: 0,
  };

  breakdown.total =
    breakdown.originRatioScore +
    breakdown.jobFreshnessScore +
    breakdown.techStackScore +
    breakdown.contactScore +
    breakdown.companyFitScore;

  const hardDisqualificationReason = getHardDisqualificationReason(input);
  const status = hardDisqualificationReason ? 'disqualified' : resolveStatus(breakdown.total, thresholds);
  const disqualificationReason = hardDisqualificationReason
    ?? (status === 'disqualified' ? deriveDisqualificationReason(input, breakdown, thresholds?.cold) : undefined);

  logger.debug(
    {
      domain: company.domain,
      score: breakdown.total,
      status,
      breakdown: {
        origin:   breakdown.originRatioScore,
        jobs:     breakdown.jobFreshnessScore,
        tech:     breakdown.techStackScore,
        contacts: breakdown.contactScore,
        fit:      breakdown.companyFitScore,
      },
    },
    '[scorer] Company scored'
  );

  return { score: breakdown.total, status, breakdown, disqualificationReason };
}

function deriveDisqualificationReason(
  input: ScoringInput,
  breakdown: ScoreBreakdown,
  coldThreshold = 20,
): string {
  const { company, contacts, jobs } = input;
  const activeEngineeringJobs = getActiveEngineeringJobs(jobs);
  const hasHiringSignal = companyHasHiringSignal(company, jobs);

  if (!hasHiringSignal) {
    return 'No engineering hiring signal was verified from jobs, hiring sources, or saved open roles.';
  }
  if (activeEngineeringJobs.length === 0 || breakdown.jobFreshnessScore <= 0) {
    return 'Hiring source evidence exists, but recent active engineering roles still need verification.';
  }
  if ((company.originRatio ?? 0) <= 0 && breakdown.originRatioScore <= 0) {
    return 'No India-team signal was verified from collected employee data.';
  }
  if (breakdown.techStackScore <= 0) {
    return 'No matching target tech stack signal was found.';
  }
  if (contacts.length === 0 && breakdown.contactScore <= 0) {
    return 'No relevant contacts were found for outreach.';
  }
  if ((company.employeeCount ?? 0) > MAX_TARGET_EMPLOYEES) {
    return 'Company is above the target size range for outbound pitching.';
  }
  if ((company.totalDevCount ?? 0) > MAX_TARGET_DEVS) {
    return 'Development team looks too large for the target outbound segment.';
  }

  return `Lead score ${breakdown.total} fell below the qualification threshold of ${coldThreshold}.`;
}

function getHardDisqualificationReason(input: ScoringInput): string | undefined {
  const { company, jobs } = input;
  const hqCountry = company.hqCountry?.toLowerCase() ?? '';
  const hasHiringSignal = companyHasHiringSignal(company, jobs);

  if (hqCountry.includes('india')) {
    return 'Company is India-headquartered, which is outside the target market.';
  }
  if ((company.employeeCount ?? 0) > MAX_TARGET_EMPLOYEES) {
    return 'Company is above the target size range for outbound pitching.';
  }
  if ((company.totalDevCount ?? 0) > MAX_TARGET_DEVS) {
    return 'Development team looks too large for the target outbound segment.';
  }
  if (!hasHiringSignal) {
    return 'No active development or engineering hiring signal was found.';
  }
  if ((company.originDevCount ?? 0) <= 0 || (company.originRatio ?? 0) <= 0) {
    return 'No Indian-origin employee signal was verified for this company.';
  }
  return undefined;
}

function companyHasHiringSignal(company: ScoringInput['company'], jobs: ScoringInput['jobs']): boolean {
  if (getActiveEngineeringJobs(jobs).length > 0) return true;
  if ((company.openRoles ?? []).length > 0) return true;
  return (company.sources ?? []).some(source => HIRING_SOURCE_SET.has(source));
}
