// ─── Shared API contract types ────────────────────────────────────────────────
// MIRROR — duplicated as genlea-frontend/src/shared-api-types.ts.
// Source of truth: this backend copy. Any edit here must be applied to the
// frontend mirror in the same commit. Run `diff` between the two to verify.

export type LeadStatus =
  | 'hot_verified' | 'hot' | 'warm' | 'cold' | 'disqualified' | 'pending';

export type PipelineStatus =
  | 'discovered' | 'watchlist' | 'enriching' | 'enriched' | 'scoring' | 'scored';

export type FundingStage =
  | 'Pre-seed' | 'Seed' | 'Series A' | 'Series B' | 'Series C' | 'Series D+'
  | 'Bootstrapped' | 'Public' | 'Acquired' | 'Unknown';

export type ScraperSource =
  | 'linkedin' | 'sales_navigator' | 'crunchbase' | 'zoominfo' | 'apollo'
  | 'hunter' | 'github' | 'glassdoor' | 'wellfound' | 'clearbit'
  | 'explorium' | 'indeed' | 'surelyremote' | 'website' | 'clay'
  | 'greenhouse' | 'lever' | 'ashby' | 'workable' | 'agent';

export type ContactRole =
  | 'CEO' | 'Founder' | 'Co-Founder'
  | 'CTO' | 'COO' | 'CPO' | 'CFO'
  | 'VP of Engineering' | 'VP Engineering'
  | 'VP of Product' | 'VP of Technology'
  | 'Head of Engineering' | 'Director of Engineering'
  | 'Head of Product' | 'Director of Product'
  | 'Head of Technology' | 'Director of Technology'
  | 'Engineering Manager'
  | 'HR' | 'Head of HR' | 'VP of HR' | 'Head of People'
  | 'Recruiter' | 'Head of Talent' | 'Talent Acquisition'
  | 'Unknown';

export type ScrapeJobStatus =
  | 'queued' | 'processing' | 'success' | 'failed' | 'partial' | 'skipped';

export type FailureMode =
  | 'success' | 'captcha' | 'blocked' | 'empty'
  | 'network_error' | 'selector_mismatch' | 'timeout' | 'unknown';

// ─── Request bodies ───────────────────────────────────────────────────────────

export interface PatchCompanyBody {
  name?: string;
  notes?: string;
}

export interface PatchCompanyStatusBody {
  status: LeadStatus;
  reason?: string;
}

export interface ScrapeRequestBody {
  source: ScraperSource;
  query: {
    keywords: string;
    location?: string;
    techStack?: string[];
    companySize?: [number, number];
    limit?: number;
  };
  limit?: number;
}
