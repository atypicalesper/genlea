import { Company, Contact, Job } from '../types/index.js';

const ENV_TARGET_TAGS = (process.env['TARGET_TECH_STACK'] ?? 'nodejs,typescript,python,react,nextjs,nestjs,frontend,backend,fullstack,ai,ml,generative-ai,fastapi')
  .split(',').map(t => t.trim());
const TARGET_FUNDING_STAGES = new Set(['Pre-seed', 'Seed', 'Series A', 'Series B', 'Series C', 'Bootstrapped']);
const GROWTH_FUNDING_STAGES = new Set(['Series D+']);
const ENGINEERING_TITLE_RE = /\b(software|engineer|developer|frontend|front-end|backend|back-end|fullstack|full-stack|platform|devops|sre|site reliability|mobile|ios|android|data engineer|machine learning|ml engineer|ai engineer|qa automation|test automation)\b/i;

// ── 1. Dev Origin Concentration (0–30) ───────────────────────────────────────
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

// ── 2. Job Posting Freshness (0–20) ──────────────────────────────────────────
export function jobFreshnessScore(jobs: Job[]): number {
  const active = getActiveEngineeringJobs(jobs);
  if (active.length === 0) return 0;

  let score = 0;
  for (const job of active) {
    // Some scrapers only prove that a role is open, not when it was posted.
    if (!job.postedAt) { score += 1; continue; } // unknown date → minimal credit
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

// ── 3. Tech Stack Alignment (0–20) ───────────────────────────────────────────
export function techStackScore(company: Company, jobs: Job[], targetTags: string[] = ENV_TARGET_TAGS): number {
  // Company-level and job-level tags are combined because each source sees a different slice of reality.
  const allTags = new Set([
    ...(company.techStack ?? []),
    ...jobs.flatMap(j => j.techTags ?? []),
  ]);

  let score = 0;
  for (const tag of allTags) {
    if (targetTags.includes(tag)) {
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

  // The funnel values decision-makers and hiring contacts more than generic employee records.
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
export function companyFitScore(company: Company, _highValueIndustries: string[] = []): number {
  let score = 0;

  const emp = company.employeeCount;
  if (emp !== undefined && emp !== null) {
    if (emp >= 20 && emp <= 250) score += 6;
    else if ((emp >= 10 && emp < 20) || (emp > 250 && emp <= 500)) score += 3;
  }

  // Funded startups and modestly scaled companies are the sweet spot for agency outreach.
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
