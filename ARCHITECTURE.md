# GenLea — Lead Generation Engine Architecture

> **Goal:** Scrape US tech companies that employ Indian-origin developers at a ≥3:4 ratio and are actively hiring in Node.js / Python / AI / React / NestJS / Next.js / frontend / backend. Extract company info, CEO details, and HR contact info across multiple data sources to build high-confidence (≥70%) warm leads stored in MongoDB.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Target Profile](#2-target-profile)
3. [Data Sources & Scraping Strategy](#3-data-sources--scraping-strategy)
4. [Pipeline Architecture](#4-pipeline-architecture)
5. [Module Breakdown](#5-module-breakdown)
6. [MongoDB Schema Design](#6-mongodb-schema-design)
7. [Lead Scoring Model](#7-lead-scoring-model)
8. [Rate-Limiting & Anti-Detection](#8-rate-limiting--anti-detection)
9. [Tech Stack](#9-tech-stack)
10. [Directory Structure](#10-directory-structure)
11. [Environment Variables](#11-environment-variables)
12. [Execution Flow](#12-execution-flow)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                        GENLEA ENGINE                            │
│                                                                 │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐    │
│  │ Scrapers │───▶│  Normalizer  │───▶│  Enrichment Layer  │    │
│  │ (multi)  │    │  + Deduper   │    │  (cross-ref data)  │    │
│  └──────────┘    └──────────────┘    └────────────────────┘    │
│       │                                        │                │
│       ▼                                        ▼                │
│  ┌──────────┐    ┌──────────────┐    ┌────────────────────┐    │
│  │  Queue   │    │  Lead Scorer │    │    MongoDB Store    │    │
│  │ (BullMQ) │    │  (rules+ML)  │    │  (companies+leads) │    │
│  └──────────┘    └──────────────┘    └────────────────────┘    │
│                                                ▲                │
│                          ┌──────────────────────┘              │
│                  ┌───────┴──────┐                               │
│                  │  Dashboard   │  (read-only UI, export CSV)   │
│                  └──────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
```

The system runs fully headless, scheduled via cron or triggered manually. Each scraper feeds a central BullMQ job queue. Workers pull jobs, scrape, normalize, enrich, score, and persist.

---

## 2. Target Profile

### Company Filters
| Criteria | Value |
|---|---|
| Geography | United States (HQ) |
| Indian Dev Ratio | ≥ 3 out of every 4 devs (≥75%) — tolerance: 60–75% for wider dataset |
| Active Job Posts | At least 1 open role in target stack |
| Company Size | 10–500 employees (sweet spot: 30–200) |
| Stage | Series A → Series C or Bootstrapped profitable |
| Industry | SaaS, Fintech, HealthTech, EdTech, AI/ML |

### Tech Stack Tags (hiring for)
```
nodejs, typescript, python, react, nextjs, nestjs,
frontend, backend, fullstack, ai, ml, generative-ai,
fastapi, django, expressjs, graphql
```

### Contacts to Capture
1. **CEO / Founder** — name, email, LinkedIn URL, Twitter/X
2. **CTO** — name, email, LinkedIn URL
3. **HR Lead / Head of Talent / Recruiter** — name, email, LinkedIn URL, direct phone (if available)

---

## 3. Data Sources & Scraping Strategy

| Source | Data Available | Method | Priority |
|---|---|---|---|
| **LinkedIn** | Company, employees, job posts, HR | Playwright Stealth (headless) | ⭐⭐⭐⭐⭐ |
| **Sales Navigator** | Filtered lead lists, org charts | Playwright Stealth (session cookie) | ⭐⭐⭐⭐⭐ |
| **Crunchbase** | Funding, founders, tech stack, HQ | API + Playwright fallback | ⭐⭐⭐⭐ |
| **ZoomInfo** | Direct dials, email, HQ, technographics | Playwright Stealth | ⭐⭐⭐⭐ |
| **Apollo.io** | Email, mobile, verified contacts | API (free tier) + Playwright | ⭐⭐⭐⭐ |
| **GitHub** | Tech stack proof (language repos, commits) | GitHub REST API | ⭐⭐⭐ |
| **Hunter.io** | Email discovery by domain | REST API | ⭐⭐⭐ |
| **Glassdoor** | Job posts, employee nationality hints | Playwright Stealth | ⭐⭐ |
| **Indeed/Wellfound** | Active job posts, tech stack | HTTP scraping + Playwright | ⭐⭐⭐ |
| **Clearbit** | Enrichment (company domain → metadata) | REST API | ⭐⭐⭐ |

### Why Multiple Sources?
- Cross-referencing 3+ sources for a single lead boosts confidence significantly
- LinkedIn gives org chart + nationality signals; Crunchbase gives funding/founder; Hunter/Apollo give verified emails
- A lead confirmed across 3 sources = **high-confidence (≥70%)** warm lead

---

## 4. Pipeline Architecture

```
Phase 1: DISCOVERY
─────────────────
[Seed Queries] ──▶ [LinkedIn Company Search]
                ──▶ [Crunchbase Search API]
                ──▶ [Apollo Company Search]
                ──▶ [Wellfound Job Board]
         All results ──▶ [Company Queue]

Phase 2: ENRICHMENT
───────────────────
[Company Queue]
  ├── [LinkedIn Scraper]     ──▶ employees list → Indian ratio analysis
  ├── [GitHub API]           ──▶ tech stack confirmation
  ├── [Crunchbase Details]   ──▶ CEO/founder name, funding stage
  ├── [Hunter.io]            ──▶ email pattern discovery
  ├── [Apollo Contacts]      ──▶ HR + CEO emails
  └── [Clearbit Enrichment]  ──▶ company metadata
         All results ──▶ [Normalizer + Deduper]

Phase 3: SCORING
────────────────
[Normalized Lead] ──▶ [Scoring Engine]
  Rules:
  - Indian dev ratio score      (0–30 pts)
  - Job post freshness          (0–20 pts)
  - Tech stack match            (0–20 pts)
  - Contact completeness        (0–15 pts)
  - Company stage/size fit      (0–15 pts)
  Total: 0–100 → leads ≥65 are "HOT"

Phase 4: STORAGE
────────────────
[Scored Lead] ──▶ [MongoDB]
  ├── companies collection
  ├── contacts collection
  ├── jobs collection
  └── scrape_logs collection
```

---

## 5. Module Breakdown

### `scrapers/`
Each scraper is a standalone async module with a unified interface:

```ts
interface Scraper {
  name: string;
  scrape(query: ScrapeQuery): Promise<RawResult[]>;
  isAvailable(): Promise<boolean>;
}
```

| File | Purpose |
|---|---|
| `scrapers/linkedin.scraper.ts` | Search companies, get employees, job posts |
| `scrapers/sales-navigator.scraper.ts` | Lead list extraction with filters |
| `scrapers/crunchbase.scraper.ts` | Company info, founders, funding |
| `scrapers/zoominfo.scraper.ts` | Contact data, direct dials |
| `scrapers/apollo.scraper.ts` | Email + contact discovery |
| `scrapers/github.scraper.ts` | Tech stack validation via APIs |
| `scrapers/hunter.scraper.ts` | Email pattern + domain search |
| `scrapers/glassdoor.scraper.ts` | Job posts + employee reviews |
| `scrapers/wellfound.scraper.ts` | Startup job listings |
| `scrapers/clearbit.scraper.ts` | Company enrichment |

### `core/`
| File | Purpose |
|---|---|
| `core/browser.manager.ts` | Playwright instance pool (stealth, rotation, fingerprint spoof) |
| `core/queue.manager.ts` | BullMQ setup, job registration, retry logic |
| `core/proxy.manager.ts` | Rotating residential proxy pool |
| `core/session.manager.ts` | LinkedIn/SalesNav cookie session handler |

### `enrichment/`
| File | Purpose |
|---|---|
| `enrichment/normalizer.ts` | Merge multi-source results into unified schema |
| `enrichment/deduplicator.ts` | Fuzzy match on company name + domain |
| `enrichment/indian-ratio.analyzer.ts` | Analyze employee names via NLP to estimate Indian origin % |
| `enrichment/contact.resolver.ts` | Find + verify CEO, CTO, HR contacts |
| `enrichment/email.verifier.ts` | MX check + SMTP verify emails |

### `scoring/`
| File | Purpose |
|---|---|
| `scoring/scorer.ts` | Apply rule-based scoring (0–100) |
| `scoring/rules.ts` | Configurable scoring rules |

### `storage/`
| File | Purpose |
|---|---|
| `storage/mongo.client.ts` | MongoDB connection singleton |
| `storage/repositories/` | CRUD for each collection |

### `workers/`
| File | Purpose |
|---|---|
| `workers/discovery.worker.ts` | Process discovery queue jobs |
| `workers/enrichment.worker.ts` | Process enrichment queue jobs |
| `workers/scoring.worker.ts` | Process scoring queue jobs |

### `api/`
| File | Purpose |
|---|---|
| `api/server.ts` | Fastify REST API for dashboard + exports |
| `api/routes/leads.ts` | GET /leads with filters |
| `api/routes/jobs.ts` | GET /scrape-jobs (queue status) |
| `api/routes/export.ts` | GET /export/csv |

---

## 6. MongoDB Schema Design

### `companies` collection
```json
{
  "_id": "ObjectId",
  "name": "Acme Corp",
  "domain": "acmecorp.com",
  "linkedin_url": "https://linkedin.com/company/acme",
  "crunchbase_url": "...",
  "hq_country": "US",
  "hq_state": "CA",
  "hq_city": "San Francisco",
  "employee_count": 85,
  "indian_dev_count": 42,
  "total_dev_count": 54,
  "indian_dev_ratio": 0.78,
  "funding_stage": "Series B",
  "funding_total_usd": 15000000,
  "industry": ["SaaS", "Fintech"],
  "tech_stack": ["nodejs", "react", "python"],
  "open_roles": ["Backend Engineer", "ML Engineer"],
  "sources": ["linkedin", "crunchbase", "apollo"],
  "score": 82,
  "status": "hot",
  "created_at": "ISODate",
  "updated_at": "ISODate",
  "last_scraped_at": "ISODate"
}
```

### `contacts` collection
```json
{
  "_id": "ObjectId",
  "company_id": "ObjectId (ref: companies)",
  "role": "CEO | CTO | HR | Recruiter | Founder",
  "first_name": "Rohan",
  "last_name": "Mehta",
  "full_name": "Rohan Mehta",
  "email": "rohan@acmecorp.com",
  "email_verified": true,
  "email_confidence": 0.92,
  "phone": "+1-555-000-0000",
  "linkedin_url": "https://linkedin.com/in/rohanmehta",
  "twitter_url": "https://x.com/rohanmehta",
  "location": "San Francisco, CA",
  "sources": ["apollo", "hunter", "linkedin"],
  "indian_origin": true,
  "created_at": "ISODate",
  "updated_at": "ISODate"
}
```

### `jobs` (open roles) collection
```json
{
  "_id": "ObjectId",
  "company_id": "ObjectId (ref: companies)",
  "title": "Senior Backend Engineer",
  "tech_tags": ["nodejs", "typescript", "postgresql"],
  "source": "linkedin",
  "source_url": "https://linkedin.com/jobs/...",
  "posted_at": "ISODate",
  "scraped_at": "ISODate",
  "is_active": true
}
```

### `scrape_logs` collection
```json
{
  "_id": "ObjectId",
  "run_id": "uuid",
  "scraper": "linkedin",
  "status": "success | failed | partial",
  "companies_found": 12,
  "contacts_found": 34,
  "errors": [],
  "duration_ms": 45200,
  "started_at": "ISODate",
  "completed_at": "ISODate"
}
```

### MongoDB Indexes
```
companies:  { domain: 1 } unique
companies:  { score: -1, status: 1 }
companies:  { indian_dev_ratio: -1 }
companies:  { tech_stack: 1 }
contacts:   { company_id: 1, role: 1 }
contacts:   { email: 1 } unique sparse
jobs:       { company_id: 1, is_active: 1 }
jobs:       { posted_at: -1 }
scrape_logs: { started_at: -1 }
```

---

## 7. Lead Scoring Model

Each company-lead is scored 0–100. Leads ≥65 are flagged `hot`.

| Signal | Max Points | How |
|---|---|---|
| Indian dev ratio ≥75% | 30 | `ratio * 40`, cap 30 |
| Active job post in target stack | 20 | +5 per matching role, cap 20 |
| Tech stack match | 20 | +5 per stack match, cap 20 |
| Contact completeness | 15 | CEO email +5, HR email +5, phone +5 |
| Company fit (size + stage) | 15 | Size 30–200: +10, Series A–C: +5 |
| **Total** | **100** | |

Tolerance mode: lower threshold to 60% Indian ratio so more companies enter the funnel (flagged as `warm` @ 50–64, `hot` @ 65+).

---

## 8. Rate-Limiting & Anti-Detection

### Playwright Stealth Setup
- `playwright-extra` + `puppeteer-extra-plugin-stealth` equivalent for Playwright
- Randomized `user-agent` per session (real Chrome UA string bank)
- Human-like mouse movement via `ghost-cursor` or manual jitter
- Random scroll, hover delays between actions
- Viewport randomization (1280–1920 wide, 768–1080 tall)
- WebGL, canvas, audio fingerprint spoofing

### Proxy Strategy
- Residential rotating proxies (BrightData / Oxylabs / Smartproxy)
- One proxy per browser context, rotated every N requests
- Proxy health check before use

### Session Management (LinkedIn / SalesNav)
- Maintain warm LinkedIn sessions in cookie files (`sessions/`)
- Never scrape > 100 profiles per session per day
- Session cooldown: 8h between heavy scrapes
- Multiple accounts in rotation pool

### Rate Limits (per source)
| Source | Requests/min | Daily Cap |
|---|---|---|
| LinkedIn | 3–5 | 300 profiles |
| Sales Navigator | 5–8 | 500 leads |
| Crunchbase API | 10 | 2000/month |
| Apollo API | 20 | 300/month (free) |
| Hunter.io API | 10 | 25/month (free) |
| GitHub API | 60 (auth) | 5000/hour |

---

## 9. Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript 5 (strict) |
| Browser Automation | Playwright + playwright-extra (stealth) |
| Job Queue | BullMQ (Redis-backed) |
| Database | MongoDB 7 (Atlas or local) |
| Cache | Redis 7 |
| API Server | Fastify v4 |
| Name origin NLP | `ethnicolr` (Python microservice) or `name-to-nationality` npm pkg |
| Email Verify | `mailcheck.ai` API / Custom SMTP verifier |
| Scheduler | `node-cron` |
| Logging | Pino |
| Config | `dotenv-flow` |
| Testing | Vitest |

---

## 10. Directory Structure

```
genlea/
├── .claude/                    # Claude prompts + context
│   ├── CLAUDE.md               # Project context for AI pair-programming
│   └── prompts/                # Reusable prompts per module
│       ├── scraper.prompt.md
│       ├── schema.prompt.md
│       └── scoring.prompt.md
│
├── src/
│   ├── scrapers/               # Source-specific scrapers
│   ├── core/                   # Browser, queue, proxy, session managers
│   ├── enrichment/             # Normalizer, deduper, indian-ratio, email verify
│   ├── scoring/                # Lead scoring rules engine
│   ├── workers/                # BullMQ workers
│   ├── storage/                # MongoDB client + repositories
│   ├── api/                    # Fastify REST API
│   └── index.ts                # Entry point (CLI or cron runner)
│
├── sessions/                   # LinkedIn/SalesNav cookie sessions (gitignored)
├── proxies/                    # Proxy list (gitignored)
├── logs/                       # Scrape logs (gitignored)
├── exports/                    # CSV exports (gitignored)
│
├── scripts/                    # One-off utility scripts
│   ├── seed-queries.ts         # Seed initial company queries
│   └── verify-emails.ts        # Batch email verification
│
├── ARCHITECTURE.md             # This document
├── SCRAPING_NOTES.md           # Per-source scraping notes
├── LEAD_SCORING.md             # Scoring rubric details
├── .env.example                # All env vars documented
├── .gitignore
├── package.json
├── tsconfig.json
└── README.md
```

---

## 11. Environment Variables

```env
# MongoDB
MONGO_URI=mongodb+srv://...
MONGO_DB_NAME=genlea

# Redis (BullMQ)
REDIS_URL=redis://localhost:6379

# Proxy
PROXY_LIST=proxies/proxy-list.txt
PROXY_PROVIDER=brightdata  # brightdata | oxylabs | smartproxy
BRIGHTDATA_USERNAME=...
BRIGHTDATA_PASSWORD=...
BRIGHTDATA_ZONE=residential

# LinkedIn Sessions
LI_SESSION_DIR=sessions/linkedin
LI_USERNAME=...          # fallback account
LI_PASSWORD=...

# APIs
CRUNCHBASE_API_KEY=...
APOLLO_API_KEY=...
HUNTER_API_KEY=...
CLEARBIT_API_KEY=...
GITHUB_TOKEN=...

# Scraping Config
MAX_CONCURRENT_BROWSERS=3
SCRAPE_DELAY_MIN_MS=2000
SCRAPE_DELAY_MAX_MS=8000
INDIAN_RATIO_THRESHOLD=0.60    # 0.75 strict, 0.60 tolerance
LEAD_SCORE_HOT_THRESHOLD=65

# API Server
API_PORT=4000
API_SECRET=...
```

---

## 12. Execution Flow

```bash
# 1. Start Redis + MongoDB (docker-compose)
docker-compose up -d

# 2. Seed initial discovery queries
npx ts-node scripts/seed-queries.ts

# 3. Start workers
npm run workers

# 4. Start API + dashboard
npm run api

# 5. Manual run a specific scraper
npm run scrape -- --source linkedin --query "software company US hiring nodejs"

# 6. Export hot leads to CSV
curl http://localhost:4000/export/csv?status=hot > leads.csv
```

### Cron Schedule (default)
| Job | Schedule | Description |
|---|---|---|
| Discovery | 0 2 * * * | Nightly at 2AM — find new companies |
| Enrichment | 0 4 * * * | Nightly at 4AM — enrich discovered companies |
| Email Verify | 0 6 * * * | Nightly at 6AM — verify emails |
| Scoring | 0 7 * * * | Nightly at 7AM — rescore all leads |
