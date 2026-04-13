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

  const status = resolveStatus(breakdown.total, thresholds);

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

  return { score: breakdown.total, status, breakdown };
}
