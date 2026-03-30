import { Company, Contact, Job, ScoreBreakdown, FundingStage } from '../types/index.js';

const TARGET_TAGS = (process.env['TARGET_TECH_STACK'] ?? 'nodejs,typescript,python,react,nextjs,nestjs,frontend,backend,fullstack,ai,ml,generative-ai,fastapi')
  .split(',').map(t => t.trim());

// ── 1. Dev Origin Concentration (0–30) ───────────────────────────────────────
export function originRatioScore(company: Company): number {
  const ratio = company.originRatio;
  if (ratio === undefined || ratio === null) return 0;
  if (ratio >= 0.90) return 30;
  if (ratio >= 0.75) return 25;
  if (ratio >= 0.60) return 17; // tolerance floor
  if (ratio >= 0.50) return 10;
  return 0;
}

// ── 2. Job Posting Freshness (0–20) ──────────────────────────────────────────
export function jobFreshnessScore(jobs: Job[]): number {
  const active = jobs.filter(j => j.isActive);
  if (active.length === 0) return 0;

  let score = 0;
  for (const job of active) {
    if (!job.postedAt) { score += 1; continue; } // unknown date → minimal credit
    const daysAgo = Math.floor((Date.now() - new Date(job.postedAt).getTime()) / 86_400_000);
    if (daysAgo <= 7)  score += 5;
    else if (daysAgo <= 30) score += 3;
    else if (daysAgo <= 90) score += 1;
    if (score >= 20) break;
  }
  return Math.min(score, 20);
}

// ── 3. Tech Stack Alignment (0–20) ───────────────────────────────────────────
export function techStackScore(company: Company, jobs: Job[]): number {
  const allTags = new Set([
    ...company.techStack,
    ...jobs.flatMap(j => j.techTags),
  ]);

  let score = 0;
  for (const tag of allTags) {
    if (TARGET_TAGS.includes(tag)) {
      // AI/ML/Gen-AI roles are highest value clients
      if (['ai', 'ml', 'generative-ai'].includes(tag)) score += 5;
      else score += 3;
    }
    if (score >= 20) break;
  }
  return Math.min(score, 20);
}

// ── 4. Contact Completeness (0–15) ───────────────────────────────────────────
export function contactScore(contacts: Contact[]): number {
  let score = 0;

  const ceo = contacts.find(c => ['CEO', 'Founder', 'CTO'].includes(c.role));
  const hr  = contacts.find(c => ['HR', 'Recruiter', 'Head of Talent'].includes(c.role));

  if (ceo?.email) score += ceo.emailVerified ? 5 : 3;
  if (hr?.email)  score += hr.emailVerified  ? 5 : 3;
  if (ceo?.phone || hr?.phone) score += 3;
  if (ceo?.linkedinUrl) score += 1;
  if (hr?.linkedinUrl)  score += 1;

  return Math.min(score, 15);
}

// ── 5. Company Profile Fit (0–15) ─────────────────────────────────────────────
export function companyFitScore(company: Company): number {
  let score = 0;

  // Size
  const emp = company.employeeCount ?? 0;
  if (emp >= 30 && emp <= 200) score += 7;
  else if ((emp >= 11 && emp < 30) || (emp > 200 && emp <= 500)) score += 4;

  // Funding stage
  const stageScores: Partial<Record<FundingStage, number>> = {
    'Series A': 5, 'Series B': 5, 'Series C': 4,
    'Bootstrapped': 3, 'Seed': 2, 'Pre-seed': 1,
  };
  score += stageScores[company.fundingStage ?? 'Unknown'] ?? 0;

  // Industry bonus
  const highValueIndustries = ['ai', 'saas', 'fintech', 'healthtech', 'edtech'];
  const companyIndustries = company.industry.map(i => i.toLowerCase());
  if (highValueIndustries.some(i => companyIndustries.some(ci => ci.includes(i)))) {
    score += 3;
  }

  return Math.min(score, 15);
}
