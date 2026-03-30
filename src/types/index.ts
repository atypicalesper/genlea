// ─────────────────────────────────────────────────────────────────────────────
// GenLea — Core Type Definitions
// All shared types for scrapers, enrichment, scoring, and storage
// ─────────────────────────────────────────────────────────────────────────────

// ── Enums ─────────────────────────────────────────────────────────────────────

export type ScraperSource =
  | 'linkedin'
  | 'sales_navigator'
  | 'crunchbase'
  | 'zoominfo'
  | 'apollo'
  | 'hunter'
  | 'github'
  | 'glassdoor'
  | 'wellfound'
  | 'clearbit'
  | 'indeed';

export type ContactRole = 'CEO' | 'CTO' | 'COO' | 'Founder' | 'HR' | 'Recruiter' | 'Head of Talent' | 'Engineering Manager' | 'Unknown';

export type FundingStage =
  | 'Pre-seed'
  | 'Seed'
  | 'Series A'
  | 'Series B'
  | 'Series C'
  | 'Series D+'
  | 'Bootstrapped'
  | 'Public'
  | 'Acquired'
  | 'Unknown';

export type LeadStatus = 'hot_verified' | 'hot' | 'warm' | 'cold' | 'disqualified' | 'pending';

export type ScrapeJobStatus = 'queued' | 'processing' | 'success' | 'failed' | 'partial';

// ── Scraper Interface ─────────────────────────────────────────────────────────

export interface ScrapeQuery {
  keywords: string;
  location?: string;
  companySize?: [number, number];
  techStack?: string[];
  limit?: number;
}

export interface RawCompany {
  name: string;
  domain: string;
  linkedinUrl?: string;
  linkedinSlug?: string;
  crunchbaseUrl?: string;
  websiteUrl?: string;
  hqCountry?: string;
  hqState?: string;
  hqCity?: string;
  employeeCount?: number;
  employeeCountRange?: string;
  fundingStage?: FundingStage;
  fundingTotalUsd?: number;
  foundedYear?: number;
  industry?: string[];
  techStack?: string[];
  description?: string;
  githubOrg?: string;
}

export interface RawContact {
  fullName: string;
  firstName?: string;
  lastName?: string;
  role: ContactRole;
  companyDomain: string;
  email?: string;
  emailConfidence?: number;
  phone?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  location?: string;
  isIndianOrigin?: boolean;
}

export interface RawJob {
  companyDomain: string;
  title: string;
  source?: ScraperSource;
  techTags?: string[];
  sourceUrl?: string;
  postedAt?: Date;
  description?: string;
}

export interface RawResult {
  source: ScraperSource;
  company?: Partial<RawCompany>;
  contacts?: Partial<RawContact>[];
  jobs?: Partial<RawJob>[];
  scrapedAt: Date;
  error?: string;
}

export interface Scraper {
  name: ScraperSource;
  scrape(query: ScrapeQuery): Promise<RawResult[]>;
  isAvailable(): Promise<boolean>;
}

// ── Normalized / DB Types ─────────────────────────────────────────────────────

export interface Company {
  _id?: string;
  name: string;
  domain: string;
  description?: string;
  linkedinUrl?: string;
  crunchbaseUrl?: string;
  websiteUrl?: string;
  githubOrg?: string;
  hqCountry: string;
  hqState?: string;
  hqCity?: string;
  employeeCount?: number;
  /** Count of developers identified as South Asian origin */
  originDevCount?: number;
  totalDevCount?: number;
  /** Ratio of South Asian-origin devs to total devs (0–1) */
  originRatio?: number;
  /** True when included via relaxed originRatio threshold */
  toleranceIncluded: boolean;
  fundingStage?: FundingStage;
  fundingTotalUsd?: number;
  foundedYear?: number;
  industry: string[];
  techStack: string[];
  openRoles: string[];
  sources: ScraperSource[];
  score: number;
  scoreBreakdown?: ScoreBreakdown;
  status: LeadStatus;
  manuallyReviewed: boolean;
  sourcesCount: number;
  lastJobPostedDays?: number;
  createdAt: Date;
  updatedAt: Date;
  lastScrapedAt: Date;
}

export interface Contact {
  _id?: string;
  companyId: string;
  role: ContactRole;
  firstName?: string;
  lastName?: string;
  fullName: string;
  email?: string;
  emailVerified: boolean;
  emailConfidence: number;
  phone?: string;
  linkedinUrl?: string;
  twitterUrl?: string;
  location?: string;
  isIndianOrigin?: boolean;
  sources: ScraperSource[];
  createdAt: Date;
  updatedAt: Date;
}

export interface Job {
  _id?: string;
  companyId: string;
  title: string;
  techTags: string[];
  source?: ScraperSource;
  sourceUrl?: string;
  postedAt?: Date;
  scrapedAt: Date;
  isActive: boolean;
}

export interface ScrapeLog {
  _id?: string;
  runId: string;
  scraper: ScraperSource;
  status: ScrapeJobStatus;
  companiesFound: number;
  contactsFound: number;
  jobsFound: number;
  errors: string[];
  durationMs: number;
  startedAt: Date;
  completedAt?: Date;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

export interface ScoreBreakdown {
  /** Dev origin concentration score (0–30) */
  originRatioScore: number;
  /** Job posting freshness score (0–20) */
  jobFreshnessScore: number;
  /** Tech stack alignment score (0–20) */
  techStackScore: number;
  /** Contact data completeness score (0–15) */
  contactScore: number;
  /** Company size + funding stage fit score (0–15) */
  companyFitScore: number;
  total: number;
}

export interface ScoringInput {
  company: Company;
  contacts: Contact[];
  jobs: Job[];
}

export interface ScoringResult {
  score: number;
  status: LeadStatus;
  breakdown: ScoreBreakdown;
}

// ── Queue ─────────────────────────────────────────────────────────────────────

export interface DiscoveryJobData {
  runId: string;
  source: ScraperSource;
  query: ScrapeQuery;
}

export interface EnrichmentJobData {
  runId: string;
  companyId: string;
  domain: string;
  sources: ScraperSource[];
}

export interface ScoringJobData {
  runId: string;
  companyId: string;
}

// ── Proxy & Browser ───────────────────────────────────────────────────────────

export interface ProxyConfig {
  host: string;
  port: number;
  username?: string;
  password?: string;
  protocol: 'http' | 'https' | 'socks5';
}

export interface BrowserContextOptions {
  proxy?: ProxyConfig;
  cookiesPath?: string;
  userAgent?: string;
  viewport?: { width: number; height: number };
}

// ── API ───────────────────────────────────────────────────────────────────────

export interface LeadFilter {
  status?: LeadStatus;
  minScore?: number;
  techStack?: string[];
  fundingStage?: FundingStage;
  hqState?: string;
  page?: number;
  limit?: number;
}

export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
  meta?: {
    total: number;
    page: number;
    limit: number;
  };
}
