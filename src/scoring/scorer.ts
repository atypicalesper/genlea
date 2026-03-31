import { ScoringInput, ScoringResult, LeadStatus, ScoreBreakdown } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  originRatioScore,
  jobFreshnessScore,
  techStackScore,
  contactScore,
  companyFitScore,
} from './rules.js';

// Env-var defaults — overridden at call time by values from settingsRepository
const ENV_HOT_VERIFIED_THRESHOLD = parseInt(process.env['LEAD_SCORE_HOT_VERIFIED_THRESHOLD'] ?? '80', 10);
const ENV_HOT_THRESHOLD          = parseInt(process.env['LEAD_SCORE_HOT_THRESHOLD']           ?? '55', 10);
const ENV_WARM_THRESHOLD         = parseInt(process.env['LEAD_SCORE_WARM_THRESHOLD']          ?? '38', 10);
const ENV_COLD_THRESHOLD         = parseInt(process.env['LEAD_SCORE_COLD_THRESHOLD']          ?? '20', 10);

export function scoreCompany(
  input: ScoringInput,
  thresholds?: { hotVerified?: number; hot: number; warm: number; cold?: number }
): ScoringResult {
  const { company, contacts, jobs } = input;

  const breakdown: ScoreBreakdown = {
    originRatioScore:  originRatioScore(company),
    jobFreshnessScore: jobFreshnessScore(jobs),
    techStackScore:    techStackScore(company, jobs),
    contactScore:      contactScore(contacts),
    companyFitScore:   companyFitScore(company),
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
        origin: breakdown.originRatioScore,
        jobs: breakdown.jobFreshnessScore,
        tech: breakdown.techStackScore,
        contacts: breakdown.contactScore,
        fit: breakdown.companyFitScore,
      },
    },
    '[scorer] Company scored'
  );

  return { score: breakdown.total, status, breakdown };
}

function resolveStatus(score: number, thresholds?: { hotVerified?: number; hot: number; warm: number; cold?: number }): LeadStatus {
  const hotVerified = thresholds?.hotVerified ?? ENV_HOT_VERIFIED_THRESHOLD;
  const hot         = thresholds?.hot         ?? ENV_HOT_THRESHOLD;
  const warm        = thresholds?.warm        ?? ENV_WARM_THRESHOLD;
  const cold        = thresholds?.cold        ?? ENV_COLD_THRESHOLD;
  if (score >= hotVerified) return 'hot_verified';
  if (score >= hot)         return 'hot';
  if (score >= warm)        return 'warm';
  if (score >= cold)        return 'cold';
  return 'disqualified';
}
