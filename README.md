# GenLea

> Automated B2B Lead Generation Engine — Finds US tech companies (YC, seed, series-A) with high Indian developer ratios that are actively hiring and extracts CEO, CTO, and HR contact information.

---

## What It Does

1. **Discovers** YC-backed and early-stage US startups via LinkedIn, Wellfound, Crunchbase, Apollo, Indeed, and more
2. **Filters** for companies with ≥60% Indian-origin developers (≥75% strict mode)
3. **Verifies** active hiring in Node.js / Python / React / AI / NestJS / Next.js stack
4. **Extracts** CEO, CTO, and HR contact info (email, phone, LinkedIn)
5. **Scores** each lead 0–100 based on fit, freshness, and contact completeness
6. **Exports** hot leads (≥65) as CSV or via REST API

---

## Quick Start

### Prerequisites
- Node.js 20+
- Docker (MongoDB + Redis via docker-compose)
- LinkedIn account for session scraping (free)
- Residential proxy (optional — BrightData / Oxylabs)

### Setup

```bash
# 1. Install dependencies
npm install

# 2. Configure environment
cp .env.example .env
# Fill in: LI_USERNAME, LI_PASSWORD, GROQ_API_KEY (free at console.groq.com)
# API keys (all optional — Playwright fallbacks exist): APOLLO_API_KEY, HUNTER_API_KEY, GITHUB_TOKEN

# 3. Start infrastructure (MongoDB + Redis)
docker-compose up -d

# 4. Initialize DB indexes (run once)
npm run db:init

# 5. Start everything
npm run dev

# 6. Seed the scrape queue
npm run seed         # 1 round (19 jobs)
npm run seed:100     # 100 rounds (1900 jobs)
```

> After `npm run dev`, the scheduler automatically re-seeds discovery every 6 hours.
> Change interval with `SCRAPE_INTERVAL_HOURS` in `.env`.

---

## Dashboards & Monitoring

| URL | What it shows |
|---|---|
| `http://localhost:4000/dashboard` | Companies dashboard — filterable table, scores, contacts, CSV export |
| `http://localhost:4000/queues` | Bull Board — live queue depths, job status, retry controls |
| `http://localhost:8081` | Mongo Express — raw collection browser (login: `admin` / `genlea_dev`) |

### Companies Dashboard (`/dashboard`)

- Filter by status (hot / warm / cold), min score, tech stack, funding stage
- Click any row to see full company detail — contacts grouped by role, verified emails
- **Export CSV** button — downloads filtered results instantly
- Auto-refreshes every 30s

### Queue Monitor (`/queues`)

- See discovery → enrichment → scoring pipeline in real time
- Retry failed jobs manually
- Shows repeatable (scheduled) jobs and their next run time

---

## CLI Commands

### Servers

| Command | What it does |
|---|---|
| `npm run dev` | Start everything — workers, API server, scheduler. **This is the only command you need for normal use.** |
| `npm run api` | API server only (dashboard + Bull Board + REST endpoints). No workers running. |
| `npm run workers` | BullMQ workers only (discovery, enrichment, scoring). No API server. |

### Scraping

| Command | What it does |
|---|---|
| `npm run seed` | Push 1 round of 22 discovery jobs across all sources (Wellfound, LinkedIn, Indeed, Crunchbase, Apollo, Glassdoor) into the queue. Workers must be running to process them. |
| `npm run seed:10` | Push 10 rounds = 220 jobs. Good for a medium-sized initial run. |
| `npm run seed:50` | Push 50 rounds = 1,100 jobs. |
| `npm run seed:100` | Push 100 rounds = 2,200 jobs. Use for bulk scraping sessions. |
| `npm run seed -- 42` | Push any arbitrary number of rounds. |
| `npm run scrape -- --source wellfound --query "nodejs startup US"` | Manually trigger a single scrape from a specific source. |
| `npm run login` | Open a browser to log into LinkedIn and save the session cookie. Run this once before LinkedIn scraping. |

### Data & Leads

| Command | What it does |
|---|---|
| `npm run stats` | Print a summary table in the terminal: total companies, hot_verified, hot, warm, cold counts. |
| `npm run export` | Export hot leads (score ≥65) to `exports/leads-export.csv`. Includes CEO/HR name, email, phone, LinkedIn. |
| `npm run export -- --status warm` | Export warm leads instead. |
| `npm run export -- --min-score 75 --out exports/top-leads.csv` | Export only high-confidence leads to a custom path. |
| `npm run score` | Re-run the scoring engine on all companies in the database. Useful after changing scoring thresholds in `.env`. |
| `npm run verify-emails` | Batch SMTP-verify up to 500 unverified contact emails. Marks them verified/invalid in MongoDB. |

### Setup & Maintenance

| Command | What it does |
|---|---|
| `npm run db:init` | Create MongoDB indexes. Run **once** after first setup or after dropping the database. |
| `npm run build` | TypeScript type-check (no output files). Run to validate code before deploying. |
| `npm run lint` | ESLint across `src/`. |
| `npm run test` | Run Vitest test suite. |

---

## API Endpoints

```bash
GET  /api/leads                          # Paginated lead list (filterable)
GET  /api/leads?status=hot&minScore=75   # Filter by status + score
GET  /api/leads?techStack=nodejs         # Filter by tech stack
GET  /api/companies/:id                  # Full company + contacts + jobs
GET  /api/companies/domain/:domain       # Look up by domain
GET  /api/stats                          # Summary counts (total/hot/warm/cold)
GET  /api/export/csv                     # Download CSV (hot leads, score ≥65)
GET  /api/export/csv?status=warm&minScore=50
POST /api/scrape                         # Manually trigger a scrape job
GET  /health                             # Health check
GET  /health/queues                      # Queue stats JSON
```

---

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design.

```
[Scrapers] → [Discovery Queue] → [Enrichment Queue] → [Scoring Queue] → [MongoDB]
                                                                              ↓
                                                          [Fastify API + Dashboard + CSV Export]
```

Each phase is a BullMQ worker backed by Redis. All Playwright scraping uses stealth mode + rotating residential proxies.

**3 Queue phases:**
1. `genlea-discovery` — find companies, enqueue for enrichment
2. `genlea-enrichment` — get contacts + tech stack + Indian ratio via Groq AI
3. `genlea-scoring` — score 0–100, write final status to MongoDB

---

## Data Sources

| Source | Purpose | Method | Key required? |
|---|---|---|---|
| Wellfound | YC + early-stage startups + jobs | Playwright | No |
| Indeed | Job listings + companies | Playwright | No |
| LinkedIn | Employees, jobs, contacts | Playwright stealth | Account only |
| Apollo.io | Email + contact discovery | API + Playwright fallback | No (free tier available) |
| Crunchbase | Founders, funding stage | API + Playwright fallback | No (free tier: crunchbase.com) |
| Hunter.io | Email pattern discovery | API + Playwright + SMTP fallback | No (free tier: 25/mo) |
| GitHub | Tech stack proof | REST API | No (token increases rate limit) |
| ZoomInfo | Direct phone numbers | Playwright stealth | Account only |

---

## Lead Scoring

| Score | Status | Action |
|---|---|---|
| 80–100 | 🔥 hot_verified | Immediate outreach |
| 65–79 | 🔥 hot | Personalized outreach |
| 50–64 | 🌡️ warm | Nurture sequence |
| < 50 | ❄️ cold | Skip |

See [`LEAD_SCORING.md`](./LEAD_SCORING.md) for the full scoring rubric.

---

## AI (Groq)

GenLea uses **Groq** (`llama-3.1-8b-instant`) for name-origin classification — the core signal for Indian dev ratio. Free tier at [console.groq.com](https://console.groq.com).

Cascade: Groq → Python ethnicolr microservice → regex fallback.

---

## Directory Structure

```
genlea/
├── src/
│   ├── ai/             # Groq client
│   ├── scrapers/       # One module per data source
│   ├── core/           # Browser, queue, proxy, session, scheduler
│   ├── enrichment/     # Normalize, dedup, ratio analyzer, email verifier
│   ├── scoring/        # Rule-based 0–100 scorer
│   ├── workers/        # BullMQ workers (discovery, enrichment, scoring)
│   ├── storage/        # MongoDB repositories
│   └── api/            # Fastify REST API + dashboard + Bull Board
├── scripts/            # CLI utilities (seed, db-init, verify-emails)
├── services/name-origin/ # Python ethnicolr microservice (optional)
├── sessions/           # LinkedIn session cookies (gitignored)
├── proxies/            # Proxy lists (gitignored)
├── exports/            # CSV output (gitignored)
├── logs/               # genlea.log (gitignored)
├── ARCHITECTURE.md
├── SCRAPING_NOTES.md
├── LEAD_SCORING.md
└── .env.example
```

---

## Important Notes

- **LinkedIn anti-scraping**: Max 80 profiles/session/day. Sessions rotate automatically with 8h cooldown.
- **Proxy**: Residential proxies recommended for LinkedIn/ZoomInfo. Datacenter IPs get blocked.
- **Free to run**: Wellfound, Indeed, Apollo web, Crunchbase web, Hunter SMTP fallback all work without API keys.
- **Data freshness**: Scheduler re-runs all discovery queries every 6 hours automatically.
