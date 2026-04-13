import type { LeadStatus } from '../types/index.js';

const ENV_HOT_VERIFIED_THRESHOLD = parseInt(process.env['LEAD_SCORE_HOT_VERIFIED_THRESHOLD'] ?? '80', 10);
const ENV_HOT_THRESHOLD          = parseInt(process.env['LEAD_SCORE_HOT_THRESHOLD']           ?? '55', 10);
const ENV_WARM_THRESHOLD         = parseInt(process.env['LEAD_SCORE_WARM_THRESHOLD']          ?? '38', 10);
const ENV_COLD_THRESHOLD         = parseInt(process.env['LEAD_SCORE_COLD_THRESHOLD']          ?? '20', 10);

export function resolveStatus(
  score: number,
  thresholds?: { hotVerified?: number; hot: number; warm: number; cold?: number },
): LeadStatus {
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
