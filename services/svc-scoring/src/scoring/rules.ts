import type { Company, Contact, Job } from '@genlea/shared';

const ENV_TARGET_TAGS = (process.env['TARGET_TECH_STACK'] ?? 'nodejs,typescript,python,react,nextjs,nestjs,frontend,backend,fullstack,ai,ml,generative-ai,fastapi')
  .split(',').map(t => t.trim());
const TARGET_FUNDING_STAGES = new Set(['Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Bootstrapped']);
const GROWTH_FUNDING_STAGES = new Set(['Series D+']);
const ENGINEERING_TITLE_RE = /\b(software|engineer|developer|frontend|front-end|backend|back-end|fullstack|full-stack|platform|devops|sre|site reliability|mobile|ios|android|data engineer|machine learning|ml engineer|ai engineer|qa automation|test automation)\b/i;

export function originRatioScore(company: Company): number {
  const ratio = company.originRatio;
  if (ratio === undefined || ratio === null) return 0;
  if (ratio >= 0.75) return 30;
  if (ratio >= 0.50) return 24;
  if (ratio >= 0.25) return 16;
  if (ratio >= 0.10) return 8;
  if (ratio > 0) return 4;
  return 0;
}

export function jobFreshnessScore(jobs: Job[]): number {
  const active = getActiveEngineeringJobs(jobs);
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

export function isEngineeringJob(job: Pick<Job, 'title'>): boolean {
  return ENGINEERING_TITLE_RE.test(job.title ?? '');
}

export function getActiveEngineeringJobs(jobs: Job[]): Job[] {
  return jobs.filter(j => j.isActive && isEngineeringJob(j));
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

export function companyFitScore(company: Company, _highValueIndustries: string[] = []): number {
  let score = 0;

  const emp = company.employeeCount;
  if (emp !== undefined && emp !== null) {
    if (emp >= 20 && emp <= 250) score += 6;
    else if ((emp >= 10 && emp < 20) || (emp > 250 && emp <= 500)) score += 3;
  }

  const stage = company.fundingStage;
  if (stage && TARGET_FUNDING_STAGES.has(stage)) score += 4;
  else if (stage && GROWTH_FUNDING_STAGES.has(stage)) score += 2;

  const funding = company.fundingTotalUsd;
  if (funding !== undefined && funding !== null) {
    if (funding >= 1_000_000 && funding <= 250_000_000) score += 3;
    else if (funding >= 250_000 && funding < 1_000_000) score += 1;
  }

  const foundedYear = company.foundedYear;
  if (foundedYear) {
    const age = new Date().getFullYear() - foundedYear;
    if (age <= 12) score += 2;
    else if (age <= 18) score += 1;
  }

  return Math.min(score, 15);
}
