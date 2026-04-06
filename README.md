# GenLea

> Automated B2B lead generation engine. Discovers US tech companies with high Indian-origin developer ratios that are actively hiring, extracts CEO/CTO/HR contacts, and scores each lead 0–100.

---

## What it does

1. **Discovers** companies via Wellfound, LinkedIn, Indeed, Crunchbase, Apollo, Glassdoor, ZoomInfo, SurelyRemote, Explorium
2. **Enriches** each company — tech stack, employee count, funding stage, decision-maker contacts — using a LangGraph agent backed by your local LLM (Ollama `qwen3.5` by default)
3. **Analyses** employee names to estimate the Indian-origin developer ratio
4. **Scores** each lead 0–100 across 5 signals: origin ratio, job freshness, tech stack match, contact completeness, company fit
5. **Alerts** via email when an agent fails and needs human review
6. **Exports** hot leads as CSV or via REST API

---

## Prerequisites

| Requirement | Why |
|---|---|
| Node.js 20+ | Runtime |
| Docker + Docker Compose | MongoDB + Redis |
| [Ollama](https://ollama.com) + `qwen3.5` | Local LLM powering the agents |
| (Optional) Groq or Anthropic API key | Cloud LLM alternative to Ollama |
| (Optional) LinkedIn account | LinkedIn scraping — session stored in `sessions/` |
| (Optional) Residential proxy | Prevents IP bans on LinkedIn / ZoomInfo |

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

```bash
cp .env.example .env
```

Minimum required fields to get started:

```env
MONGO_URI=mongodb://localhost:27017
REDIS_URL=redis://localhost:6379

# LLM — pick one:
AGENT_LLM_PROVIDER=ollama        # default — uses your local qwen3.5
AGENT_LLM_MODEL=qwen3.5

# OR Groq (free at console.groq.com):
# AGENT_LLM_PROVIDER=groq
# GROQ_API_KEY=gsk_...

# OR Anthropic:
# AGENT_LLM_PROVIDER=anthropic
# ANTHROPIC_API_KEY=sk-ant-...
```

Optional but strongly recommended:

```env
EXPLORIUM_API_KEY=...     # Best discovery source — company DB + verified contacts
HUNTER_API_KEY=...        # Email discovery (25 free/month)
GITHUB_TOKEN=...          # Tech stack extraction (5000 req/hr vs 60 without token)
```

Agent failure email alerts (leave empty to log-only):

```env
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
ALERT_EMAIL_TO=you@gmail.com
```

### 3. Start infrastructure

```bash
docker-compose up -d
```

This starts:
- **MongoDB** on port `27017`
- **Redis** on port `6379`
- **Mongo Express** on port `8081` (optional UI — login: `admin` / `genlea_dev`)

### 4. Pull the local LLM

```bash
ollama pull qwen3.5
```

### 5. Initialise the database (run once)

```bash
npm run db:init
```

---

## Running

You need three things running simultaneously:

```bash
# Terminal 1 — Ollama (local LLM server)
ollama serve

# Terminal 2 — GenLea backend (workers + API)
npm run dev

# Terminal 3 — React frontend (optional dashboard)
cd ../genlea-frontend
npm install
npm run dev
```

> `npm run dev` starts both the BullMQ workers and the Fastify API server concurrently.

### Seed the pipeline

Once everything is running, trigger the first discovery round:

```bash
npm run seed          # 1 round (~22 discovery jobs)
npm run seed:10       # 10 rounds (~220 jobs)
npm run seed:100      # 100 rounds (~2200 jobs) — full bulk run
```

The scheduler also auto-seeds every 2 hours.

---

## How it works — full pipeline walkthrough

### 1. Scheduler triggers discovery

`src/core/scheduler.ts` runs a cron job every 2 hours (configurable). On each tick it calls `enqueueSeedRound()`, which pushes ~22 BullMQ jobs into the `genlea-discovery` queue — one per `(source, keyword)` pair. You can also trigger this manually via `npm run seed` or `POST /api/seed`.

### 2. Discovery worker + LangGraph agent

`src/workers/discovery.worker.ts` pulls each job from the queue and calls `runDiscoveryAgent(job)`.

The discovery agent is a **LangGraph `createReactAgent` loop** backed by your configured LLM (Ollama `qwen3.5` by default). It has three tools:

- `check_source_availability` — checks if the requested scraper has credentials
- `scrape_source` — runs the actual scraper (Playwright stealth browser or API call). Normalises and deduplicates results before returning them to the model.
- `save_companies` — called by the model when it has enough results. Upserts companies into MongoDB and enqueues each one for enrichment.

The agent autonomously decides: which sources to try, when to switch sources if results are thin, and when to stop. If a source is unavailable it moves to the next without breaking.

**Filter pass** (inside `scrape_source`): blocklisted enterprise domains (Google, Amazon, etc.) and companies with >1000 employees are stripped before the model ever sees them.

**Hunter pre-population** (fire-and-forget): if `HUNTER_API_KEY` is set, the save handler asynchronously pre-fetches contact emails for every discovered company before enrichment even starts.

### 3. Enrichment worker + LangGraph agent

`src/workers/enrichment.worker.ts` picks each enrichment job. Before running the agent it checks:
- company still exists in MongoDB
- employee count ≤ 1000 (auto-disqualify if not)
- 7-day cooldown not active (unless `force: true`)

Then `runEnrichmentAgent(job)` runs a second LangGraph agent with 12 tools:

| Tool | What it does |
|---|---|
| `get_company_state` | Reads current DB state — tells the agent what's already filled |
| `enrich_explorium` | API call: company metadata + verified contacts in one shot |
| `enrich_github` | Finds GitHub org, extracts tech stack from repos, gets contributor names for ratio |
| `enrich_clearbit` | Company metadata (employee count, funding, HQ) |
| `scrape_website_team` | Scrapes `/team`, `/about`, `/people` pages via Playwright |
| `playwright_scrape_url` | General-purpose stealth browser — fallback for any URL. Extracts people via JSON-LD, LinkedIn anchors, and email regexes |
| `enrich_hunter` | Email discovery via Hunter.io API |
| `verify_contacts` | SMTP-verifies existing emails, fills gaps using email patterns |
| `save_contacts` | Persists decision-maker contacts (CEO, CTO, HR, etc.) to MongoDB |
| `compute_origin_ratio` | Classifies collected names as Indian-origin via Groq/Ollama, computes ratio |
| `save_company_data` | Merges partial company data into MongoDB |
| `disqualify_company` | Marks defunct / too-large / wrong-country companies as disqualified |
| `queue_for_scoring` | Writes `lastEnrichedAt`, sets `pipelineStatus: enriched`, enqueues scoring |

The agent reads the system prompt and the current company state, then autonomously decides the order of tool calls. If Explorium is unavailable, it falls back to Clearbit + GitHub + Playwright. If no emails are found via API, it scrapes `/team` and `/contact` pages directly.

### 4. Scoring worker

`src/workers/scoring.worker.ts` runs the deterministic rule engine:

| Signal | Max pts | How |
|---|---|---|
| `originRatioScore` | 30 | Linearly scaled from `originRatioThreshold` → 1.0. Unknown ratio → 10 (neutral) |
| `jobFreshnessScore` | 20 | Active jobs posted in the last 14 days score full; decays to 0 past 90 days |
| `techStackScore` | 20 | Tags matched against `TARGET_TECH_STACK` env var |
| `contactScore` | 15 | Points for CEO/CTO/HR email presence + email verification |
| `companyFitScore` | 15 | Employee count 30–200 ideal; funding stage Seed–Series B ideal |

Total → status:

```
≥ 80  →  hot_verified
≥ 55  →  hot
≥ 38  →  warm
≥ 20  →  cold
< 20  →  disqualified
```

The `manuallyReviewed` flag prevents the scorer from overwriting statuses set by a human via the UI.

### 5. Alert on failure

Any unhandled exception in a discovery or enrichment agent calls `alertAgentFailure()` before re-throwing. If `SMTP_HOST` and `ALERT_EMAIL_TO` are set in `.env`, a structured email is sent with the agent name, company domain, run ID, error message, and stack trace. Otherwise the failure is logged at `warn` level and the BullMQ retry policy handles re-queuing (3 attempts, exponential backoff starting at 5s).

### 6. API + frontend

The Fastify API (`src/api/server.ts`) on port `4001` exposes REST endpoints for all data and queue operations. The React frontend (`../genlea-frontend`) proxies `/api`, `/health`, and `/queues` to `localhost:4001` via Vite during development.

The Bull Board queue monitor is embedded at `/queues` — it shows live job counts, failure reasons, and lets you retry failed jobs without writing code.

---

## Dashboards

| URL | What |
|---|---|
| `http://localhost:5173` | React frontend — leads table, control panel, analytics, logs |
| `http://localhost:4001/dashboard` | Inline HTML dashboard (no frontend needed) |
| `http://localhost:4001/queues` | Bull Board — live queue depths, retry controls |
| `http://localhost:8081` | Mongo Express — raw MongoDB browser |

---

## CLI commands

### Servers

| Command | What |
|---|---|
| `npm run dev` | Workers + API server + scheduler — **normal daily driver** |
| `npm run api` | API server only (no workers) |
| `npm run workers` | Workers only (no API server) |

### Scraping

| Command | What |
|---|---|
| `npm run seed` | Push 1 discovery round (~22 jobs) |
| `npm run seed:10` | Push 10 rounds |
| `npm run seed:50` | Push 50 rounds |
| `npm run seed:100` | Push 100 rounds |
| `npm run login` | Open browser to log into LinkedIn and save session cookie |

### Data

| Command | What |
|---|---|
| `npm run stats` | Print summary: total / hot_verified / hot / warm / cold counts |
| `npm run export` | Export hot leads (≥65) to `exports/leads-export.csv` |
| `npm run rescore-all` | Re-score all companies (useful after changing thresholds) |
| `npm run verify-emails` | SMTP-verify up to 500 unverified contact emails |

### Dev

| Command | What |
|---|---|
| `npm run build` | TypeScript type-check |
| `npm run lint` | ESLint |
| `npm run test` | Vitest |
| `npm run db:init` | Create MongoDB indexes (run once after first setup) |

---

## REST API

The API runs on port `4001`.

```
GET  /api/leads                            Paginated lead list
GET  /api/leads?status=hot&minScore=75     Filter by status + score
GET  /api/leads?techStack=nodejs           Filter by tech stack
GET  /api/stats                            Summary counts
GET  /api/companies/:id                    Full company detail + contacts + jobs
GET  /api/companies/domain/:domain         Look up by domain
PATCH /api/companies/:id/status            Override lead status manually
POST  /api/companies/:id/enrich            Re-queue enrichment
POST  /api/companies/:id/score             Re-queue scoring
GET  /api/contacts/for-companies?ids=...   Batch contact fetch
GET  /api/export/csv                       Download CSV (hot leads)
GET  /api/export/csv?status=warm           Download warm leads
POST /api/seed                             Trigger discovery round
POST /api/scrape                           Trigger single scrape job
GET  /api/jobs/status                      Queue counts (all 3 queues)
GET  /api/jobs/active                      Currently processing jobs
GET  /api/jobs/cron                        Cron schedule info
POST /api/jobs/rescore-all                 Queue scoring for every company
POST /api/jobs/retry/:queue                Retry all failed jobs in a queue
DELETE /api/jobs/clear/:queue              Drain a queue
GET  /api/jobs/logs                        Recent scrape logs
GET  /api/jobs/stats                       Scrape success/fail counts
GET  /api/settings                         Pipeline settings
PATCH /api/settings                        Update pipeline settings
GET  /health                               Health check
```

---

## Architecture

```
Scheduler (cron every 2h)
  └─ discovery queue
       └─ discovery.worker
            └─ LangGraph agent (qwen3.5 / Groq / Anthropic)
                 ├─ check_source_availability
                 ├─ scrape_source  → Wellfound / LinkedIn / Indeed / Apollo / ...
                 └─ save_companies → upsert DB + enqueue enrichment

  └─ enrichment queue
       └─ enrichment.worker
            └─ LangGraph agent
                 ├─ get_company_state
                 ├─ enrich_explorium / enrich_github / enrich_clearbit
                 ├─ scrape_website_team
                 ├─ playwright_scrape_url  (stealth Playwright fallback)
                 ├─ enrich_hunter / verify_contacts
                 ├─ compute_origin_ratio
                 ├─ save_contacts / save_company_data
                 ├─ disqualify_company
                 └─ queue_for_scoring

  └─ scoring queue
       └─ scoring.worker
            └─ 5-signal rule engine (0–100)
                 ├─ originRatioScore    (0–30)
                 ├─ jobFreshnessScore   (0–20)
                 ├─ techStackScore      (0–20)
                 ├─ contactScore        (0–15)
                 └─ companyFitScore     (0–15)
                      └─ → MongoDB: status (hot_verified / hot / warm / cold / disqualified)
```

Storage: MongoDB (companies, contacts, jobs, scrape_logs). Queue: BullMQ on Redis.

---

## LLM / Agent configuration

Agents use [LangGraph](https://langchain-ai.github.io/langgraphjs/) `createReactAgent` and are provider-agnostic:

| Provider | Env var | Default model | Notes |
|---|---|---|---|
| `ollama` (default) | `OLLAMA_BASE_URL` | `qwen3.5` | Free, local, no API key |
| `groq` | `GROQ_API_KEY` | `llama-3.3-70b-versatile` | Free tier at console.groq.com |
| `anthropic` | `ANTHROPIC_API_KEY` | `claude-haiku-4-5-20251001` | Paid |

Override model: `AGENT_LLM_MODEL=qwen3:32b`

---

## Lead scoring

| Score | Status | Action |
|---|---|---|
| 80–100 | 🔥 `hot_verified` | Immediate outreach |
| 55–79 | 🔥 `hot` | Personalised outreach |
| 38–54 | 🌡️ `warm` | Nurture sequence |
| 20–37 | ❄️ `cold` | Low priority |
| < 20 | ✗ `disqualified` | Skip |

Thresholds are adjustable live via `PATCH /api/settings` or the frontend control panel.

---

## Data sources

| Source | Purpose | Requires |
|---|---|---|
| Explorium | Company DB + verified contacts (best single source) | `EXPLORIUM_API_KEY` |
| Wellfound | YC + seed startups + open roles | Nothing |
| Indeed | Job listings + companies | Nothing |
| LinkedIn | Companies + employees + jobs | Account (`LI_USERNAME` + `LI_PASSWORD`) |
| Apollo | B2B contacts + company data | Nothing (free web tier) |
| Crunchbase | Funding + founders | Nothing (free web tier) |
| Glassdoor | Job listings | Nothing |
| SurelyRemote | Remote-first companies | Nothing |
| ZoomInfo | Direct phones | Account |
| Hunter.io | Email discovery | `HUNTER_API_KEY` (25/mo free) |
| GitHub | Tech stack via repos + contributor names | `GITHUB_TOKEN` (optional, increases rate limit) |
| Clearbit | Company metadata | `CLEARBIT_API_KEY` |
| Playwright | Stealth scrape fallback for any URL | Nothing |

---

## Directory structure

```
genlea/
├── src/
│   ├── agents/           # LangGraph agents (discovery, enrichment) + LLM factory
│   ├── scrapers/
│   │   ├── discovery/    # One module per source (wellfound, linkedin, apollo, ...)
│   │   └── enrichment/   # github, hunter, clearbit, explorium
│   ├── core/             # BullMQ queue manager, Playwright browser pool, proxy/session managers, scheduler
│   ├── enrichment/       # Normalizer, deduplicator, website scraper, origin analyzer, contact resolver
│   ├── scoring/          # 5-signal rule engine
│   ├── workers/          # discovery.worker, enrichment.worker, scoring.worker
│   ├── storage/
│   │   ├── mongo.client.ts
│   │   └── repositories/ # company, contact, job, scrape-log, settings
│   ├── api/
│   │   ├── server.ts     # Fastify app bootstrap
│   │   ├── dashboard.ts  # Inline HTML dashboard
│   │   └── routes/       # leads, companies, jobs, scrape, export, settings
│   ├── types/            # Shared TypeScript types
│   └── utils/            # logger, alert (email), helpers
├── scripts/              # db-init, seed-queries, rescore-all, verify-emails
├── sessions/             # LinkedIn session cookies (gitignored)
├── proxies/              # Proxy lists (gitignored)
├── exports/              # CSV output (gitignored)
├── logs/                 # genlea.log (gitignored)
├── docker-compose.yml
├── .env.example
├── ARCHITECTURE.md
├── LEAD_SCORING.md
└── SCRAPING_NOTES.md
```

---

## Notes

- **LinkedIn anti-scraping**: max 80 profiles/session/day, 8h cooldown. Sessions rotate automatically.
- **Proxy**: residential proxies recommended for LinkedIn and ZoomInfo. Datacenter IPs get blocked.
- **Free to run**: Wellfound, Indeed, Apollo web, Crunchbase web, GitHub (no token), Hunter SMTP fallback, Playwright — all work with zero API keys. Only Explorium, Hunter API, Clearbit, and ZoomInfo require credentials.
- **manuallyReviewed flag**: if you override a company's status via the UI or API, the scoring engine will never overwrite it.
- **Cooldown**: enrichment skips companies re-processed within 7 days unless `force: true` is passed.
