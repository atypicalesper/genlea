import type { LeadStatus } from '@genlea/shared';

export function resolveStatus(
  score: number,
  thresholds?: {
    hotVerified?: number;
    hot: number;
    warm: number;
    cold?: number;
  }
): LeadStatus {
  const hotVerified = thresholds?.hotVerified ?? parseInt(process.env['SCORE_HOT_VERIFIED'] ?? '80', 10);
  const hot         = thresholds?.hot         ?? parseInt(process.env['SCORE_HOT']          ?? '55', 10);
  const warm        = thresholds?.warm        ?? parseInt(process.env['SCORE_WARM']         ?? '38', 10);
  const cold        = thresholds?.cold        ?? parseInt(process.env['SCORE_COLD']         ?? '20', 10);

  if (score >= hotVerified) return 'hot_verified';
  if (score >= hot)         return 'hot';
  if (score >= warm)        return 'warm';
  if (score >= cold)        return 'cold';
  return 'disqualified';
}
