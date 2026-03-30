import { ScoringInput, ScoringResult, LeadStatus, ScoreBreakdown } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  originRatioScore,
  jobFreshnessScore,
  techStackScore,
  contactScore,
  companyFitScore,
} from './rules.js';

const HOT_THRESHOLD  = parseInt(process.env['LEAD_SCORE_HOT_THRESHOLD']  ?? '65');
const WARM_THRESHOLD = parseInt(process.env['LEAD_SCORE_WARM_THRESHOLD'] ?? '50');

export function scoreCompany(input: ScoringInput): ScoringResult {
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

  const status = resolveStatus(breakdown.total);

  logger.info(
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

function resolveStatus(score: number): LeadStatus {
  if (score >= 80) return 'hot_verified';
  if (score >= HOT_THRESHOLD)  return 'hot';
  if (score >= WARM_THRESHOLD) return 'warm';
  if (score >= 35) return 'cold';
  return 'disqualified';
}
