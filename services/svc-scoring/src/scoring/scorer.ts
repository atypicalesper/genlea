import type { ScoringInput, ScoringResult, ScoreBreakdown } from '@genlea/shared';
import { logger } from '@genlea/shared';
import {
  originRatioScore,
  jobFreshnessScore,
  techStackScore,
  contactScore,
  companyFitScore,
} from './rules.js';
import { resolveStatus } from './status-resolver.js';

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
  const activeJobs = jobs.filter(job => job.isActive);

  if (activeJobs.length === 0 || breakdown.jobFreshnessScore <= 0) {
    return 'No recent active engineering hiring signal was found.';
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
  if ((company.employeeCount ?? 0) > 1000) {
    return 'Company is above the target size range for outbound pitching.';
  }

  return `Lead score ${breakdown.total} fell below the qualification threshold of ${coldThreshold}.`;
}

function getHardDisqualificationReason(input: ScoringInput): string | undefined {
  const { company, jobs } = input;
  const activeJobs = jobs.filter(job => job.isActive);
  const hqCountry = company.hqCountry?.toLowerCase() ?? '';
  const foundedYear = company.foundedYear;
  const companyAge = foundedYear ? new Date().getFullYear() - foundedYear : undefined;
  const hasVerifiedFunding =
    (!!company.fundingStage && !['Unknown', 'Bootstrapped'].includes(company.fundingStage))
    || ((company.fundingTotalUsd ?? 0) > 0);

  if (hqCountry.includes('india')) {
    return 'Company is India-headquartered, which is outside the target market.';
  }
  if ((company.employeeCount ?? 0) > 1000) {
    return 'Company is too large and looks more like a big enterprise than a target startup.';
  }
  if (companyAge !== undefined && companyAge > 12) {
    return 'Company is older than the target “relatively new” startup profile.';
  }
  if (!hasVerifiedFunding) {
    return 'Funding was not verified, so the company does not meet the funded-company target.';
  }
  if (activeJobs.length === 0) {
    return 'No active development or engineering hiring signal was found.';
  }
  if ((company.originDevCount ?? 0) <= 0 || (company.originRatio ?? 0) <= 0) {
    return 'No Indian-origin employee signal was verified for this company.';
  }
  return undefined;
}
