# GenLea

> Automated B2B lead generation engine. Discovers tech companies globally with high Indian-origin developer ratios that are actively hiring, extracts CEO/CTO/HR contacts, and scores each lead 0–100.

---

## What it does

1. **Discovers** companies via Wellfound, LinkedIn, Indeed, Crunchbase, Apollo, Glassdoor, ZoomInfo, SurelyRemote, Explorium
2. **Enriches** each company — tech stack, employee count, funding stage, decision-maker contacts — using an LLM agent backed by Ollama / Groq / Anthropic
3. **Analyses** employee names to estimate the Indian-origin developer ratio
4. **Scores** each lead 0–100 across 5 signals: origin ratio, job freshness, tech stack match, contact completeness, company fit
5. **Exports** hot leads as CSV or via REST API

---

## Architecture

GenLea is a **microservices monorepo** (npm workspaces). Four independent services communicate only through BullMQ queues on Redis and a shared MongoDB instance.

```
packages/
  shared/             — @genlea/shared: types, repositories, queue, browser pool, utilities

services/
  svc-discovery/      — cron scheduler + discovery worker + 11 scrapers + LLM agent
  svc-enrichment/     — enrichment worker + 5 scrapers + origin ratio analysis + LLM agent
  svc-scoring/        — scoring worker (rule engine, no Playwright)
  svc-api/            — Fastify REST API + Bull Board dashboard
```

**Pipeline:**
```
svc-discovery (cron every 2h)
  → genlea-discovery queue → svc-discovery worker
      └─ LLM agent: scrape → normalise → dedup → save → enqueue enrichment

  → genlea-enrichment queue → svc-enrichment worker
      └─ LLM agent: GitHub / Explorium / Clearbit / Hunter / Playwright → origin ratio → enqueue scoring

  → genlea-scoring queue → svc-scoring worker
      └─ rule engine (0–100) → status: hot_verified / hot / warm / cold / disqualified
```

---

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js 20+ | Runtime |
| Docker + Docker Compose | MongoDB + Redis |
| [Ollama](https://ollama.com) + `qwen3.5` | Local LLM for agents (free, runs offline) |
| Groq API key | Cloud LLM alternative — free tier at console.groq.com |
| (Optional) Anthropic API key | Cloud LLM alternative |
| (Optional) LinkedIn account | LinkedIn scraping — session stored in `sessions/` |
| (Optional) Residential proxy | Prevents IP bans on LinkedIn / ZoomInfo |

---

## Quick start

### Option A — Local dev (recommended)

Runs infra in Docker, services directly on your machine. Fastest for development.

**Step 1: Start MongoDB + Redis**

```bash
cd /path/to/genlea
docker-compose up -d mongo redis
```

**Step 2: Configure environment**

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```env
MONGO_URI=mongodb://localhost:27017/genlea
REDIS_URL=redis://localhost:6379

# LLM — pick one:
AGENT_LLM_PROVIDER=groq        # easiest — free tier at console.groq.com
GROQ_API_KEY=gsk_...

# OR local Ollama (no API key needed):
# AGENT_LLM_PROVIDER=ollama
# AGENT_LLM_MODEL=qwen3.5

# OR Anthropic:
# AGENT_LLM_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-...
```

Strongly recommended:

```env
EXPLORIUM_API_KEY=...     # Best discovery source — company DB + verified contacts
HUNTER_API_KEY=...        # Email discovery (25 free/month)
GITHUB_TOKEN=...          # Tech stack extraction (5000 req/hr vs 60 without)
```

**Step 3: Install dependencies**

```bash
npm install
```

This installs all workspace packages and symlinks `@genlea/shared` into every service's `node_modules`.

**Step 4: Initialise the database (run once)**

```bash
npm run db:init
```

**Step 5 (Ollama only): Pull and serve the model**

```bash
brew install ollama      # one-time
ollama pull qwen3.5      # one-time
ollama serve             # keep running in background
```

Skip this step if using Groq or Anthropic.

**Step 6: Start the services**

Open four terminal tabs:

```bash
# Tab 1 — API + dashboard
npm run dev -w services/svc-api

# Tab 2 — discovery worker + cron scheduler
npm run dev -w services/svc-discovery

# Tab 3 — enrichment worker
npm run dev -w services/svc-enrichment

# Tab 4 — scoring worker
npm run dev -w services/svc-scoring
```

Each service reads `.env` from the repo root. They share MongoDB and Redis but run as independent processes.

**Dashboards:**

| URL | What |
|---|---|
| `genlea-frontend` | Lead pipeline UI — run separately (see `genlea-frontend/`) |
| `http://localhost:4000/queues` | Bull Board — live queue depths + retry |
| `http://localhost:8081` | Mongo Express — raw DB browser (admin / genlea_dev) |

---

### Option B — Full Docker

Builds and runs everything as containers. Closest to production.

```bash
cp .env.example .env   # fill in values
docker-compose up --build
```

Starts all six containers: mongo, redis, mongo-express, svc-api, svc-discovery, svc-enrichment, svc-scoring.

Note: when running in Docker, `MONGO_URI` and `REDIS_URL` are automatically overridden to use Docker network hostnames — you don't need to change them in `.env` for this mode.

---

## Seed the pipeline

Once running, trigger the first discovery round:

```bash
npm run seed          # 1 round (~48 discovery jobs)
npm run seed:10       # 10 rounds
npm run seed:100      # 100 rounds — full bulk run
```

The scheduler in `svc-discovery` also auto-seeds every 2 hours.

---

## Dashboards

| URL | What |
|---|---|
| `genlea-frontend` | Lead pipeline UI — run separately (see `genlea-frontend/`) |
| `http://localhost:4000/queues` | Bull Board — live queue depths, retry controls |
| `http://localhost:8081` | Mongo Express — raw MongoDB browser (login: `admin` / `genlea_dev`) |

---

## CLI commands

### Dev

| Command | What |
|---|---|
| `npm run dev` | Workers + API (monolith mode) |
| `npm run dev -w services/svc-api` | API service only |
| `npm run dev -w services/svc-discovery` | Discovery service only |
| `npm run dev -w services/svc-enrichment` | Enrichment service only |
| `npm run dev -w services/svc-scoring` | Scoring service only |
| `npm run build:services` | Type-check all 4 services |

### Scraping

| Command | What |
|---|---|
| `npm run seed` | Push 1 discovery round |
| `npm run seed:10` | Push 10 rounds |
| `npm run seed:50` | Push 50 rounds |
| `npm run seed:100` | Push 100 rounds |
| `npm run login` | Open browser to log into LinkedIn and save session cookie |

### Data

| Command | What |
|---|---|
| `npm run stats` | Print lead count by status |
| `npm run export` | Export hot leads (≥65) to `exports/leads-export.csv` |
| `npm run rescore-all` | Re-score all companies (use after changing thresholds) |
| `npm run verify-emails` | SMTP-verify up to 500 unverified contact emails |

### Maintenance

| Command | What |
|---|---|
| `npm run build:services` | `tsc --noEmit` across all 4 services |
| `npm run lint` | ESLint (monolith `src/`) |
| `npm run test` | Vitest |
| `npm run db:init` | Create MongoDB indexes (run once) |

---

## REST API

API runs on port `4000`.

```
GET    /api/leads                        Paginated lead list
GET    /api/leads?status=hot&minScore=75 Filter by status + score
GET    /api/stats                        Summary counts
GET    /api/companies/:id                Full company + contacts + jobs
GET    /api/companies/domain/:domain     Look up by domain
PATCH  /api/companies/:id/status         Override lead status manually
POST   /api/companies/:id/enrich         Re-queue enrichment
POST   /api/companies/:id/score          Re-queue scoring
GET    /api/export/csv                   Download CSV (hot leads)
GET    /api/export/csv?status=warm       Download warm leads
POST   /api/seed                         Trigger a discovery round
POST   /api/scrape                       Trigger a single scrape job
GET    /api/jobs/status                  Queue depths (all 3 queues)
GET    /api/jobs/active                  Currently processing jobs
GET    /api/jobs/cron                    Cron schedule info
POST   /api/jobs/rescore-all             Queue scoring for every company
POST   /api/jobs/retry/:queue            Retry all failed jobs in a queue
DELETE /api/jobs/clear/:queue            Drain a queue
GET    /api/jobs/logs                    Recent scrape logs
GET    /api/jobs/stats                   Scrape success/fail counts
GET    /api/settings                     Pipeline settings
PATCH  /api/settings                     Update pipeline settings
POST   /admin/reset-db                   Wipe all collections + drain queues
GET    /health                           Health check
GET    /health/queues                    Queue stats health check
```

---

## Deployment

### Docker Compose (single server)

The standard deployment path. All services are defined in `docker-compose.yml`.

```bash
# Build and start everything
docker-compose up -d --build

# View logs for a specific service
docker-compose logs -f svc-discovery
docker-compose logs -f svc-enrichment
docker-compose logs -f svc-api

# Restart a single service after a code change
docker-compose up -d --build svc-enrichment

# Stop everything
docker-compose down
```

Each service container:
- Reads `.env` from the repo root via `env_file: .env`
- Has `MONGO_URI` and `REDIS_URL` overridden to use Docker network hostnames (`mongo`, `redis`)
- Restarts automatically on crash (`restart: unless-stopped`)

### Environment variables in production

Set all secrets as environment variables on the host (or in a secrets manager). The `env_file: .env` directive in `docker-compose.yml` reads from a `.env` file next to `docker-compose.yml`. On a server:

```bash
# On the server, create .env with production values
nano /opt/genlea/.env
# Then:
docker-compose --env-file /opt/genlea/.env up -d
```

### Scaling individual services

Discovery and enrichment are the bottlenecks — they run Playwright and call external APIs. To scale them horizontally, run multiple replicas. Since all state is in MongoDB and Redis (not in-process), replicas are stateless:

```bash
docker-compose up -d --scale svc-discovery=2 --scale svc-enrichment=3
```

Concurrency within each replica is controlled via settings:

```bash
curl -X PATCH http://localhost:4000/api/settings \
  -H 'Content-Type: application/json' \
  -d '{"workerConcurrencyDiscovery": 3, "workerConcurrencyEnrichment": 2}'
```

Workers poll these settings every 10 seconds and adjust without restart.

---

## Maintenance

### Adding a new scraper

1. Create `services/svc-discovery/src/scrapers/mysource.scraper.ts` implementing the `Scraper` interface from `@genlea/shared`
2. Export it from `services/svc-discovery/src/scrapers/index.ts`
3. Add it to `SCRAPERS` in `services/svc-discovery/src/discovery/blocklists.ts`
4. Add availability check in `packages/shared/src/scheduler.ts` → `getAvailableSources()`
5. Add seed queries for it in `packages/shared/src/scheduler.ts` → `SEED_QUERIES`

No other files need changing — the agent discovers available scrapers at runtime.

### Adding a new enrichment source

Same pattern but in `services/svc-enrichment/src/scrapers/`. Add a tool for it in `services/svc-enrichment/src/agents/enrichment-tools.ts` and reference it in the agent's system prompt.

### Modifying shared utilities

Edit files under `packages/shared/src/`. All services pick up the change immediately on next start (or live via `tsx watch` in dev). No publish step needed.

### Changing scoring weights

Edit `services/svc-scoring/src/scoring/rules.ts`. Dynamic thresholds (hot/warm/cold cutoffs) are stored in MongoDB settings and adjustable live via `PATCH /api/settings` — no restart needed.

### Database indexes

If you add new query patterns to a repository, add the corresponding index in `scripts/db-init.ts` and re-run:

```bash
npm run db:init
```

---

## LLM / Agent configuration

| Provider | Env var | Default model |
|---|---|---|
| `ollama` (default) | `OLLAMA_BASE_URL` | `qwen3.5` |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` |

Override the model: `AGENT_LLM_MODEL=qwen3:32b`

**Ollama context tuning:**

| Env var | Default | What it controls |
|---|---|---|
| `OLLAMA_NUM_CTX` | `32768` | Total context window (input + output combined) |
| `OLLAMA_NUM_PREDICT` | `8192` | Max output tokens per generation |

Reduce these if running a larger model with less VRAM.

---

## Lead scoring

| Score | Status | Action |
|---|---|---|
| 80–100 | `hot_verified` | Immediate outreach |
| 55–79 | `hot` | Personalised outreach |
| 38–54 | `warm` | Nurture sequence |
| 20–37 | `cold` | Low priority |
| < 20 | `disqualified` | Skip |

Thresholds are adjustable live via `PATCH /api/settings`.

---

## Data sources

| Source | Purpose | Requires |
|---|---|---|
| Explorium | Company DB + verified contacts | `EXPLORIUM_API_KEY` |
| Wellfound | YC + seed startups + open roles | Nothing |
| Indeed | Job listings + companies | Nothing |
| LinkedIn | Companies + employees + jobs | Account (`LI_USERNAME`) |
| Apollo | B2B contacts + company data | Nothing (free web tier) |
| Crunchbase | Funding + founders | Nothing (free web tier) |
| Glassdoor | Job listings | Nothing |
| SurelyRemote | Remote-first companies | Nothing |
| ZoomInfo | Direct phones | Account |
| Clay | Company + contacts | `CLAY_API_KEY` |
| Hunter.io | Email discovery | `HUNTER_API_KEY` (25/mo free) |
| GitHub | Tech stack + contributor names | `GITHUB_TOKEN` (optional) |
| Clearbit | Company metadata | `CLEARBIT_API_KEY` |
| Playwright | Stealth scrape fallback | Nothing |

---

## Directory structure

```
genlea/
├── packages/
│   └── shared/               — @genlea/shared (types, repos, queue, browser, utils)
│       └── src/
│           ├── types/
│           ├── utils/
│           ├── storage/repositories/
│           ├── queue/
│           ├── core/          — browser/proxy/session managers
│           ├── enrichment/    — normalizer, deduplicator, email verifier
│           └── scheduler.ts   — seed queries + enqueueSeedRound
│
├── services/
│   ├── svc-api/               — Fastify API, Bull Board
│   ├── svc-discovery/         — cron + discovery worker + 11 scrapers + LLM agent
│   ├── svc-enrichment/        — enrichment worker + 5 scrapers + origin analysis + LLM agent
│   └── svc-scoring/           — scoring worker (rule engine)
│
├── src/                       — original monolith (kept for reference / scripts)
├── scripts/                   — db-init, seed-queries, rescore-all, verify-emails
├── sessions/                  — LinkedIn session cookies (gitignored)
├── proxies/                   — proxy lists (gitignored)
├── exports/                   — CSV output (gitignored)
├── docker-compose.yml
├── tsconfig.base.json         — base TS config extended by all services
└── .env.example
```

---

## Notes

- **LinkedIn anti-scraping**: max 80 profiles/session/day, 8h cooldown, sessions rotate automatically
- **Proxy**: residential proxies strongly recommended for LinkedIn and ZoomInfo
- **Free to run**: Wellfound, Indeed, Apollo, Crunchbase, GitHub (no token), Playwright — zero API keys needed for a basic run
- **manuallyReviewed flag**: UI/API status overrides are never overwritten by the scoring engine
- **Enrichment cooldown**: companies re-processed within 7 days are skipped unless `force: true`
- **Backlog guard**: if the discovery queue exceeds 200 waiting jobs, the scheduler skips that cron tick to prevent runaway growth (configurable via `DISCOVERY_BACKLOG_THRESHOLD`)
