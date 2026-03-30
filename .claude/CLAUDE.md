# GenLea — Claude AI Context
> **⚠️ READ THIS FIRST on every new session** — this file is the single source of truth for this project.
> Location: `/Users/rac/Desktop/pp/genlea/.claude/CLAUDE.md`
> Additional prompts: `/Users/rac/Desktop/pp/genlea/.claude/prompts/`

---

## 🧭 What This Project Is

**GenLea** is a B2B lead-generation engine built for a software agency targeting US tech companies to sell offshore Indian developer talent. The system:

1. **Discovers** US tech companies (SaaS, Fintech, AI, HealthTech) that already employ a high % of Indian-origin developers — proving they trust and hire Indian devs
2. **Scrapes** LinkedIn, Crunchbase, Apollo, ZoomInfo, Hunter, GitHub, Wellfound across multiple passes
3. **Analyzes** employee names via NLP/ML to estimate Indian-developer ratio per company
4. **Filters** companies where ≥60–75% of developers appear to be of Indian origin AND they're actively hiring in target stacks
5. **Extracts** CEO, CTO, and HR contact info (verified email, phone, LinkedIn)
6. **Scores** each company 0–100 using a 5-signal rule engine
7. **Exports** hot leads (score ≥65) via REST API + CSV

**Why this works:** Companies that already have 60–75% Indian devs are warm to working with Indian developers — these are pre-qualified, high-conversion (≥70%) leads for the agency.

---

## 📁 Project Root

```
/Users/rac/Desktop/pp/genlea/
```

All files live here. **Never write to tmp or outside this directory.**

---

## 🗺️ What Has Been Built (Current State)

### ✅ Planning & Docs (complete)
| File | Status | Purpose |
|---|---|---|
| `ARCHITECTURE.md` | ✅ Done | 12-section master architecture doc |
| `SCRAPING_NOTES.md` | ✅ Done | Per-source scraping guide (LinkedIn, Apollo, etc.) |
| `LEAD_SCORING.md` | ✅ Done | Full scoring rubric with exact point values |
| `.env.example` | ✅ Done | All 30+ env vars documented |
| `README.md` | ✅ Done | Quick-start + overview |
| `docker-compose.yml` | ✅ Done | Mongo 7, Redis 7, Mongo Express, Bull Board |
| `package.json` | ✅ Done | All deps (Playwright, BullMQ, MongoDB, Fastify, Zod) |
| `tsconfig.json` | ✅ Done | Strict TypeScript + NodeNext + path aliases |
| `.gitignore` | ✅ Done | Sessions/proxies/exports protected |

### ✅ Core Types (complete)
| File | Status | Purpose |
|---|---|---|
| `src/types/index.ts` | ✅ Done | All shared TS types (Scraper, Company, Contact, Job, Score) |

### ✅ Core Infrastructure (complete)
| File | Status | Purpose |
|---|---|---|
| `src/core/browser.manager.ts` | ✅ Done | Playwright stealth pool, human scroll, CAPTCHA detect |
| `src/core/proxy.manager.ts` | ✅ Done | BrightData + file-based proxy rotation, fail tracking |
| `src/core/session.manager.ts` | ✅ Done | LinkedIn session cookies, daily limits, cooldown, auto-login |

### 🔄 Being Built Now
| File | Status | Notes |
|---|---|---|
| `src/scrapers/clearbit.scraper.ts` | 🔄 Next | Company enrichment (logo, description, tech) |
| `src/api/routes/companies.ts` | 🔄 Next | Separate companies route with full detail |

### ✅ Newly Completed (this session)
| File | Status | Purpose |
|---|---|---|
| `src/enrichment/email.verifier.ts` | ✅ Done | MX + raw SMTP probe, disposable domain check |
| `src/enrichment/deduplicator.ts` | ✅ Done | Domain-keyed company, email-keyed contact, title-keyed job |
| `src/enrichment/contact.resolver.ts` | ✅ Done | SMTP verify existing emails + Hunter gap-fill for CEO/HR |
| `src/scrapers/zoominfo.scraper.ts` | ✅ Done | Playwright login + company/contacts tab (phone numbers) |
| `src/index.ts` | ✅ Done | Commander CLI (scrape/score/stats/export/login) |
| `scripts/verify-emails.ts` | ✅ Done | Batch SMTP verify up to 500 pending contacts |
| `src/workers/enrichment.worker.ts` | ✅ Done | Wired: GitHub → Hunter → contactResolver → originRatio |
| `services/name-origin/` | ✅ Done | Separate git repo — education-signal Python classifier |

### ❌ Genuinely Not Yet Started
| File | Status | Purpose |
|---|---|---|
| `src/scrapers/clearbit.scraper.ts` | ❌ | Logo, domain→company enrichment |
| `src/api/routes/companies.ts` | ❌ | Separate company detail route |
| `src/scrapers/indeed.scraper.ts` | ❌ | Free job scraping from Indeed |
| `scripts/rescore-all.ts` | ❌ | Re-run scoring on all existing companies |

---

## 🏗️ Architecture (Quick Summary)

```
[Scrapers] → [Queue: BullMQ] → [Workers] → [Normalizer] → [Deduplicator] → [Indian Ratio Analyzer] → [Scorer] → [MongoDB]
                                                                                                                        ↓
                                                                                                         [Fastify API] → [CSV Export]
```

**3 Queue Phases:**
1. `discovery` — find companies via scraper, enqueue for enrichment
2. `enrichment` — get full company details + contacts, enqueue for scoring
3. `scoring` — score 0–100, write final status to MongoDB

**MongoDB Collections:** `companies`, `contacts`, `jobs`, `scrape_logs`

**Canonical dedup key:** `domain` (e.g., `acme.com`) — always normalize before write

---

## 🔑 Key Patterns (Always Follow These)

### Scraper Interface
Every scraper MUST implement this — no exceptions:
```ts
interface Scraper {
  name: ScraperSource;
  scrape(query: ScrapeQuery): Promise<RawResult[]>;
  isAvailable(): Promise<boolean>;
}
```
Return `RawResult[]` — never write to MongoDB directly from a scraper.

### Browser Stealth
```ts
import { browserManager } from '../core/browser.manager.js';
import { proxyManager } from '../core/proxy.manager.js';

const proxy = proxyManager.getProxy();
const context = await browserManager.createContext(browserId, { proxy, cookiesPath });
const page = await browserManager.newPage(context);
await browserManager.humanDelay(2000, 6000);  // always delay
await browserManager.humanScroll(page, 5);    // always scroll humanly
```

### Queue Jobs
```ts
import { queueManager } from '../core/queue.manager.js';
await queueManager.addDiscoveryJob({ runId, source, query });
await queueManager.addEnrichmentJob({ runId, companyId, domain, sources });
await queueManager.addScoringJob({ runId, companyId });
```

### Repository Upsert (always deduplicate by domain)
```ts
import { companyRepository } from '../storage/repositories/company.repository.js';
// domain is normalized before upsert (lowercase, strip www., strip /)
await companyRepository.upsert(normalizedCompany);
```

### Logger usage
```ts
import { logger } from '../utils/logger.js';
logger.info({ scraper: 'linkedin', company: 'acme.com', runId }, 'Scraped company');
logger.warn({ accountId, reason: 'captcha' }, 'Session paused');
logger.error({ err, domain }, 'Failed to scrape');
```

---

## 📊 MongoDB Schema (Quick Reference)

### `companies`
```ts
{ name, domain (unique), linkedinUrl, employeeCount, indianDevCount, totalDevCount,
  indianDevRatio, toleranceIncluded, fundingStage, techStack[], openRoles[], sources[],
  score (0-100), status ('hot'|'warm'|'cold'|'disqualified'), scoreBreakdown{...},
  createdAt, updatedAt, lastScrapedAt }
```

### `contacts`
```ts
{ companyId, role ('CEO'|'CTO'|'HR'|'Recruiter'), fullName, email, emailVerified,
  emailConfidence (0-1), phone, linkedinUrl, isIndianOrigin, sources[], createdAt }
```

### `jobs`
```ts
{ companyId, title, techTags[], source, sourceUrl, postedAt, isActive, scrapedAt }
```

### `scrape_logs`
```ts
{ runId, scraper, status, companiesFound, contactsFound, errors[], durationMs, startedAt }
```

---

## 🎯 Lead Scoring (Quick Reference)

```
score = indianRatioScore (0-30)
      + jobFreshnessScore (0-20)
      + techStackScore (0-20)
      + contactScore (0-15)
      + companyFitScore (0-15)
      = 0-100

≥80 → hot_verified 🔥
65-79 → hot 🔥
50-64 → warm 🌡️
<50 → cold/disqualified ❄️
```

Indian ratio threshold: env `INDIAN_RATIO_THRESHOLD` (default 0.60, strict 0.75)
Full rubric: `LEAD_SCORING.md`

---

## 🛡️ Anti-Detection Rules (Never Skip These)

| Rule | Value |
|---|---|
| Max profiles/LinkedIn session/day | 80 (env: `LI_MAX_PROFILES_PER_SESSION`) |
| Delay between navigations | 2–8s randomized |
| Max concurrent browsers | 3 (env: `MAX_CONCURRENT_BROWSERS`) |
| Session cooldown after limit | 8h (env: `LI_SESSION_COOLDOWN_HOURS`) |
| Proxy | Always rotate residential proxies |
| Resource blocking | Block images, fonts, ads, tracking pixels |
| Fingerprint | Spoof webdriver, plugins, WebGL, canvas |

---

## 💻 Tech Stack

| Layer | Tech |
|---|---|
| Runtime | Node.js 20 LTS |
| Language | TypeScript 5 strict |
| Browser | Playwright (stealth mode) |
| Queue | BullMQ (Redis-backed) |
| DB | MongoDB 7 |
| Cache | Redis 7 |
| API | Fastify v4 |
| Validation | Zod |
| Logging | Pino |
| Config | dotenv-flow |

---

## ⚡ Commands

```bash
# Start all (dev mode)
npm run dev

# Workers only
npm run workers

# API only
npm run api

# Manual scrape
npm run scrape -- --source linkedin --query "nodejs startup US"

# Re-score all
npm run score

# Export CSV
npm run export

# Init DB indexes (run once)
npm run db:init

# Docker infra
docker-compose up -d
```

---

## 🔄 How to Continue After a Break

1. Read this file top to bottom
2. Check **"What Has Been Built"** table above — find the first ❌ row
3. Check the relevant prompt in `.claude/prompts/` for the module type (scraper/schema/scoring)
4. Continue building from where `🔄` or first `❌` starts
5. Always run `npm run build` after adding new files to validate TypeScript

**If you're not sure what's done:** run `ls src/**/*.ts` to see existing files.

---

## 📍 Memory Location for Future Sessions

> Tell any new Claude session:
> **"Read /Users/rac/Desktop/pp/genlea/.claude/CLAUDE.md — it has the full project state, what's built, what's missing, and all patterns to follow."**
