import type { Company, Contact, Job, FundingStage } from '@genlea/shared';

const ENV_TARGET_TAGS = (process.env['TARGET_TECH_STACK'] ?? 'nodejs,typescript,python,react,nextjs,nestjs,frontend,backend,fullstack,ai,ml,generative-ai,fastapi')
  .split(',').map(t => t.trim());

const ENV_HIGH_VALUE_INDUSTRIES = ['ai', 'saas', 'fintech', 'healthtech', 'edtech'];

export function originRatioScore(company: Company): number {
  const ratio = company.originRatio;
  if (ratio === undefined || ratio === null) return 10;
  if (ratio >= 0.90) return 30;
  if (ratio >= 0.75) return 25;
  if (ratio >= 0.60) return 17;
  if (ratio >= 0.50) return 10;
  return 0;
}

export function jobFreshnessScore(jobs: Job[]): number {
  const active = jobs.filter(j => j.isActive);
  if (active.length === 0) return 0;

  let score = 0;
  for (const job of active) {
    if (!job.postedAt) { score += 1; continue; }
    const daysAgo = Math.floor((Date.now() - new Date(job.postedAt).getTime()) / 86_400_000);
    if (daysAgo <= 7)  score += 5;
    else if (daysAgo <= 30) score += 3;
    else if (daysAgo <= 90) score += 1;
    if (score >= 20) break;
  }
  return Math.min(score, 20);
}

export function techStackScore(company: Company, jobs: Job[], targetTags: string[] = ENV_TARGET_TAGS): number {
  const allTags = new Set([
    ...(company.techStack ?? []),
    ...jobs.flatMap(j => j.techTags ?? []),
  ]);

  let score = 0;
  for (const tag of allTags) {
    if (targetTags.includes(tag)) {
      if (['ai', 'ml', 'generative-ai'].includes(tag)) score += 5;
      else score += 3;
    }
    if (score >= 20) break;
  }
  return Math.min(score, 20);
}

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

export function companyFitScore(company: Company, highValueIndustries: string[] = ENV_HIGH_VALUE_INDUSTRIES): number {
  let score = 0;

  const emp = company.employeeCount;
  if (emp === undefined || emp === null) score += 2;
  else if (emp >= 30 && emp <= 200) score += 7;
  else if ((emp >= 11 && emp < 30) || (emp > 200 && emp <= 500)) score += 4;

  const stageScores: Partial<Record<FundingStage, number>> = {
    'Series A': 5, 'Series B': 5, 'Series C': 4,
    'Bootstrapped': 3, 'Seed': 2, 'Pre-seed': 1,
  };
  score += stageScores[company.fundingStage ?? 'Unknown'] ?? 0;

  const companyIndustries = (company.industry ?? []).map(i => i.toLowerCase());
  if (
    companyIndustries.length === 0 ||
    highValueIndustries.some(i => companyIndustries.some(ci => ci.includes(i)))
  ) {
    score += 3;
  }

  return Math.min(score, 15);
}
