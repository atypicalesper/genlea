import { RawResult, Company, Contact, ContactRole, Job, ScraperSource } from '../types/index.js';
import { normalizeDomain, normalizeEmail } from '../utils/random.js';
import { logger } from '../utils/logger.js';

/**
 * Normalizer: merges raw scraper results from multiple sources
 * into clean, validated Company, Contact, and Job objects.
 *
 * Does NOT write to MongoDB — returns normalized objects for the deduplicator.
 */
export const normalizer = {
  normalizeCompany(raw: Partial<import('../types/index.js').RawCompany>, source: ScraperSource): Partial<Company> {
    if (!raw.domain && !raw.linkedinUrl) return {};

    const domain = raw.domain
      ? normalizeDomain(raw.domain)
      : extractDomainFromUrl(raw.linkedinUrl ?? raw.websiteUrl ?? '');

    if (!domain) return {};

    return {
      name: raw.name?.trim(),
      domain,
      linkedinUrl: normalizeUrl(raw.linkedinUrl),
      crunchbaseUrl: normalizeUrl(raw.crunchbaseUrl),
      websiteUrl: normalizeUrl(raw.websiteUrl),
      hqCountry: raw.hqCountry,  // don't default — repository handles insert default
      hqState: raw.hqState?.trim(),
      hqCity: raw.hqCity?.trim(),
      employeeCount: raw.employeeCount ? parseInt(String(raw.employeeCount)) : undefined,
      fundingStage: raw.fundingStage,
      fundingTotalUsd: raw.fundingTotalUsd,
      foundedYear: raw.foundedYear,
      industry: dedupeArray(raw.industry ?? []),
      techStack: dedupeArray(normalizeTechTags(raw.techStack ?? [])),
      sources: [source],
      status: 'pending',
      score: 0,
      toleranceIncluded: false,
      manuallyReviewed: false,
      sourcesCount: 1,
      openRoles: [],
    };
  },

  normalizeContact(raw: Partial<import('../types/index.js').RawContact>, source: ScraperSource): Partial<Contact> | null {
    if (!raw.fullName && !raw.firstName) return null;

    const fullName = raw.fullName?.trim() ?? `${raw.firstName ?? ''} ${raw.lastName ?? ''}`.trim();
    if (!fullName) return null;

    const email = raw.email ? normalizeEmail(raw.email) : undefined;
    if (email && !isValidEmail(email)) {
      logger.warn({ email }, 'Invalid email — skipping');
      return null;
    }

    return {
      fullName,
      firstName: raw.firstName?.trim(),
      lastName: raw.lastName?.trim(),
      role: normalizeRole(raw.role),
      companyId: '', // filled in after company upsert
      email,
      emailVerified: false,
      emailConfidence: raw.emailConfidence ?? 0,
      phone: normalizePhone(raw.phone),
      linkedinUrl: normalizeUrl(raw.linkedinUrl),
      twitterUrl: normalizeUrl(raw.twitterUrl),
      location: raw.location?.trim(),
      isIndianOrigin: raw.isIndianOrigin,
      sources: [source],
    };
  },

  normalizeJob(raw: Partial<import('../types/index.js').RawJob>, source: ScraperSource): Partial<Job> | null {
    if (!raw.title || !raw.companyDomain) return null;

    return {
      title: raw.title.trim(),
      companyId: '', // filled in after company upsert
      techTags: dedupeArray(normalizeTechTags(raw.techTags ?? [])),
      source,
      sourceUrl: normalizeUrl(raw.sourceUrl),
      postedAt: raw.postedAt,
      isActive: true,
      scrapedAt: new Date(),
    };
  },

  /** Process a full RawResult[] batch from any scraper */
  processResults(results: RawResult[]): {
    companies: Partial<Company>[];
    contacts: Partial<Contact>[];
    jobs: Partial<Job>[];
  } {
    const companies: Partial<Company>[] = [];
    const contacts: Partial<Contact>[] = [];
    const jobs: Partial<Job>[] = [];

    for (const result of results) {
      if (result.company) {
        const c = this.normalizeCompany(result.company, result.source);
        if (c.domain) companies.push(c);
      }

      for (const contact of result.contacts ?? []) {
        const c = this.normalizeContact(contact, result.source);
        if (c) contacts.push(c);
      }

      for (const job of result.jobs ?? []) {
        const j = this.normalizeJob(job, result.source);
        if (j) jobs.push(j);
      }
    }

    return { companies, contacts, jobs };
  },
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function extractDomainFromUrl(url: string): string {
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return normalizeDomain(u.hostname);
  } catch {
    return '';
  }
}

function normalizeUrl(url?: string): string | undefined {
  if (!url) return undefined;
  const trimmed = url.trim();
  if (!trimmed.startsWith('http')) return `https://${trimmed}`;
  return trimmed;
}

function normalizePhone(phone?: string): string | undefined {
  if (!phone) return undefined;
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 7) return undefined;
  // Already has country code (starts with + in original, or digits are 11+ chars starting with 1)
  if (phone.trim().startsWith('+')) return `+${digits}`;
  // 10-digit US number — prepend country code
  if (digits.length === 10) return `+1${digits}`;
  // 11-digit starting with 1 — already has US country code
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // International or ambiguous — return as-is with + prefix
  return `+${digits}`;
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

export function normalizeRole(raw?: string): ContactRole {
  if (!raw) return 'Unknown';
  const t = raw.toLowerCase().trim();

  if (/\bco[\s-]?founder\b/.test(t))                          return 'Co-Founder';
  if (/\bfounder\b/.test(t))                                  return 'Founder';
  if (/\bchief\s+executive|^\s*ceo\b/.test(t))               return 'CEO';
  if (/\bchief\s+technology|\bcto\b/.test(t))                return 'CTO';
  if (/\bchief\s+product|\bcpo\b/.test(t))                   return 'CPO';
  if (/\bchief\s+operating|\bcoo\b/.test(t))                 return 'COO';
  if (/\bchief\s+financial|\bcfo\b/.test(t))                 return 'CFO';
  if (/\bvp[\s,]+of\s+eng|\bvp[\s,]+eng|\bvice\s+president.{0,20}engineer/.test(t)) return 'VP of Engineering';
  if (/\bvp[\s,]+of\s+product|\bvp[\s,]+product|\bvice\s+president.{0,20}product/.test(t)) return 'VP of Product';
  if (/\bvp[\s,]+of\s+tech(?!nical)|\bvp[\s,]+tech\b|\bvice\s+president.{0,20}technolog/.test(t)) return 'VP of Technology';
  if (/\bvp[\s,]+of\s+hr|\bvp[\s,]+hr|\bvice\s+president.{0,20}(human\s+res|people)/.test(t)) return 'VP of HR';
  if (/\bhead\s+of\s+engineer|\bhead\s+of\s+tech\b|\bdept\.?\s+(head|director).{0,15}engineer/.test(t)) return 'Head of Engineering';
  if (/\bhead\s+of\s+product/.test(t))                       return 'Head of Product';
  if (/\bhead\s+of\s+technolog/.test(t))                     return 'Head of Technology';
  if (/\bdirector.{0,15}engineer/.test(t))                   return 'Director of Engineering';
  if (/\bdirector.{0,15}product/.test(t))                    return 'Director of Product';
  if (/\bdirector.{0,15}technolog/.test(t))                  return 'Director of Technology';
  if (/\bengineering\s+manager|\beng\s+manager/.test(t))     return 'Engineering Manager';
  if (/\bhead\s+of\s+people\b/.test(t))                      return 'Head of People';
  if (/\bhead\s+of\s+(talent|recruiting|hr)/.test(t))        return 'Head of Talent';
  if (/\btalent\s+acquisition|\brecruit/.test(t))            return 'Recruiter';
  if (/\bhuman\s+res|\bhr\s+(manager|lead|director|head|partner)|\bpeople\s+(ops|partner|manager)/.test(t)) return 'HR';

  return 'Unknown';
}

function dedupeArray(arr: string[]): string[] {
  return [...new Set(arr.map(s => s.toLowerCase().trim()).filter(Boolean))];
}

const TECH_ALIASES: Record<string, string> = {
  // ── Node / JavaScript ──────────────────────────────────────────────────────
  'node': 'nodejs',
  'node.js': 'nodejs',
  'nodejs': 'nodejs',
  'node js': 'nodejs',
  'javascript': 'javascript',
  'js': 'javascript',
  'es6': 'javascript',
  'es2015': 'javascript',
  'vanilla js': 'javascript',
  'typescript': 'typescript',
  'ts': 'typescript',
  'type script': 'typescript',

  // ── React ─────────────────────────────────────────────────────────────────
  'react': 'react',
  'react.js': 'react',
  'reactjs': 'react',
  'react js': 'react',
  'react native': 'react-native',
  'reactnative': 'react-native',
  'rn': 'react-native',
  'react hooks': 'react',
  'redux': 'redux',
  'react redux': 'redux',
  'zustand': 'zustand',
  'recoil': 'recoil',

  // ── Next.js ───────────────────────────────────────────────────────────────
  'next': 'nextjs',
  'next.js': 'nextjs',
  'nextjs': 'nextjs',
  'next js': 'nextjs',
  'next.js 13': 'nextjs',
  'next.js 14': 'nextjs',
  'next.js 15': 'nextjs',
  'app router': 'nextjs',

  // ── NestJS ────────────────────────────────────────────────────────────────
  'nest': 'nestjs',
  'nest.js': 'nestjs',
  'nestjs': 'nestjs',
  'nest js': 'nestjs',
  'nestjsframework': 'nestjs',

  // ── Python ────────────────────────────────────────────────────────────────
  'python': 'python',
  'python3': 'python',
  'python 3': 'python',
  'py': 'python',
  'fastapi': 'fastapi',
  'fast api': 'fastapi',
  'flask': 'flask',
  'django': 'django',
  'django rest framework': 'django',
  'drf': 'django',
  'aiohttp': 'python',
  'tornado': 'python',

  // ── AI / ML ───────────────────────────────────────────────────────────────
  'ai': 'ai',
  'artificial intelligence': 'ai',
  'machine learning': 'ml',
  'ml': 'ml',
  'deep learning': 'ml',
  'neural network': 'ml',
  'neural networks': 'ml',
  'generative ai': 'generative-ai',
  'gen ai': 'generative-ai',
  'genai': 'generative-ai',
  'generativeai': 'generative-ai',
  'llm': 'generative-ai',
  'llms': 'generative-ai',
  'large language model': 'generative-ai',
  'gpt': 'generative-ai',
  'openai': 'generative-ai',
  'langchain': 'generative-ai',
  'rag': 'generative-ai',
  'retrieval augmented generation': 'generative-ai',
  'nlp': 'ml',
  'natural language processing': 'ml',
  'computer vision': 'ml',
  'cv': 'ml',
  'tensorflow': 'ml',
  'pytorch': 'ml',
  'scikit-learn': 'ml',
  'sklearn': 'ml',
  'hugging face': 'generative-ai',
  'huggingface': 'generative-ai',
  'transformers': 'generative-ai',

  // ── Frontend (general) ────────────────────────────────────────────────────
  'frontend': 'frontend',
  'front end': 'frontend',
  'front-end': 'frontend',
  'ui development': 'frontend',
  'ui engineer': 'frontend',
  'vue': 'vuejs',
  'vue.js': 'vuejs',
  'vuejs': 'vuejs',
  'vue js': 'vuejs',
  'nuxt': 'nuxtjs',
  'nuxt.js': 'nuxtjs',
  'nuxtjs': 'nuxtjs',
  'angular': 'angular',
  'angular.js': 'angularjs',
  'angularjs': 'angularjs',
  'svelte': 'svelte',
  'sveltekit': 'svelte',
  'astro': 'astro',
  'remix': 'remix',
  'tailwind': 'tailwindcss',
  'tailwindcss': 'tailwindcss',
  'tailwind css': 'tailwindcss',
  'css': 'css',
  'html': 'html',
  'html5': 'html',
  'css3': 'css',
  'sass': 'css',
  'scss': 'css',
  'storybook': 'storybook',
  'vite': 'vite',
  'webpack': 'webpack',
  'babel': 'javascript',
  'jest': 'jest',
  'cypress': 'cypress',
  'playwright': 'playwright',

  // ── Backend (general) ─────────────────────────────────────────────────────
  'backend': 'backend',
  'back end': 'backend',
  'back-end': 'backend',
  'server side': 'backend',
  'server-side': 'backend',
  'api development': 'backend',
  'rest api': 'backend',
  'restful': 'backend',
  'rest': 'backend',
  'graphql': 'graphql',
  'graph ql': 'graphql',
  'grpc': 'grpc',
  'express': 'expressjs',
  'express.js': 'expressjs',
  'expressjs': 'expressjs',
  'koa': 'nodejs',
  'hapi': 'nodejs',
  'fastify': 'fastify',
  'microservices': 'microservices',
  'micro services': 'microservices',
  'event driven': 'microservices',
  'message queue': 'microservices',
  'kafka': 'kafka',
  'rabbitmq': 'rabbitmq',
  'redis': 'redis',

  // ── Fullstack ─────────────────────────────────────────────────────────────
  'fullstack': 'fullstack',
  'full stack': 'fullstack',
  'full-stack': 'fullstack',
  'mern': 'fullstack',
  'mean': 'fullstack',
  'mevn': 'fullstack',
  't3 stack': 'fullstack',

  // ── Databases ─────────────────────────────────────────────────────────────
  'mongodb': 'mongodb',
  'mongo': 'mongodb',
  'mongo db': 'mongodb',
  'postgresql': 'postgresql',
  'postgres': 'postgresql',
  'pg': 'postgresql',
  'mysql': 'mysql',
  'sql': 'sql',
  'sqlite': 'sql',
  'prisma': 'prisma',
  'sequelize': 'sql',
  'typeorm': 'typeorm',
  'drizzle': 'sql',
  'supabase': 'postgresql',
  'dynamodb': 'dynamodb',
  'dynamo db': 'dynamodb',
  'firebase': 'firebase',
  'firestore': 'firebase',
  'elasticsearch': 'elasticsearch',
  'elastic search': 'elasticsearch',
  'pinecone': 'vector-db',
  'weaviate': 'vector-db',
  'chroma': 'vector-db',
  'qdrant': 'vector-db',

  // ── Cloud / DevOps ────────────────────────────────────────────────────────
  'aws': 'aws',
  'amazon web services': 'aws',
  'gcp': 'gcp',
  'google cloud': 'gcp',
  'google cloud platform': 'gcp',
  'azure': 'azure',
  'microsoft azure': 'azure',
  'docker': 'docker',
  'kubernetes': 'kubernetes',
  'k8s': 'kubernetes',
  'terraform': 'terraform',
  'ci/cd': 'devops',
  'devops': 'devops',
  'github actions': 'devops',
  'jenkins': 'devops',
  'serverless': 'serverless',
  'lambda': 'aws',
  'vercel': 'vercel',
  'netlify': 'netlify',

  // ── Mobile ────────────────────────────────────────────────────────────────
  'ios': 'ios',
  'swift': 'ios',
  'android': 'android',
  'kotlin': 'android',
  'flutter': 'flutter',
  'dart': 'flutter',
};

function normalizeTechTags(tags: string[]): string[] {
  return tags.map(t => {
    const lower = t.toLowerCase().trim();
    return TECH_ALIASES[lower] ?? lower;
  });
}
