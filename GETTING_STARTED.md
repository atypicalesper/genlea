# 🚀 GenLea — Getting Started Guide

> Complete step-by-step guide to run the full lead generation engine locally.

---

## Prerequisites

| Tool | Version | Install |
|---|---|---|
| Node.js | ≥ 20 LTS | [nodejs.org](https://nodejs.org) |
| Docker Desktop | Latest | [docker.com](https://docker.com) |
| Git | Any | Pre-installed on macOS |
| Python | ≥ 3.10 | Only for the name-origin service |

---

## Step 1 — Clone & Install

```bash
cd /Users/rac/Desktop/pp/genlea

# Install Node.js dependencies
npm install --legacy-peer-deps
```

---

## Step 2 — Configure Environment

The `.env` file is already created with sample values.
Fill in any credentials you have before running scrapers.

```bash
# Open and fill in your credentials
open .env       # or: code .env
```

**Minimum required to run (with no paid APIs):**
```env
MONGO_URI=mongodb://localhost:27017    ← already set
REDIS_URL=redis://localhost:6379       ← already set
# Everything else is optional — scrapers fall back to web mode
```

**To unlock full pipeline, add:**
```env
LI_USERNAME=your@email.com            # LinkedIn account (for session login)
LI_PASSWORD=yourpassword
GITHUB_TOKEN=ghp_xxxxx                # Free — github.com/settings/tokens
```

---

## Step 3 — Start Infrastructure (MongoDB + Redis)

```bash
# Start MongoDB 7, Redis 7, Mongo Express UI, Bull Board
docker-compose up -d

# Verify everything is running
docker-compose ps
```

**Dashboards available after this step:**
| UI | URL | Purpose |
|---|---|---|
| Mongo Express | http://localhost:8081 | Browse MongoDB collections |
| Bull Board | http://localhost:3001 | Monitor job queues |
| GenLea API | http://localhost:4000 | REST API (after Step 6) |

---

## Step 4 — Initialize Database

Creates all MongoDB indexes (run once):

```bash
npm run db:init
```

Expected output:
```
✅ companies indexes created
✅ contacts indexes created
✅ jobs indexes created
✅ scrape_logs indexes created
✅ All indexes created — database ready
```

---

## Step 5 — (Optional) Start the Name-Origin Service

The talent origin classifier runs as a separate Python service.
Start it if you want more accurate South Asian origin detection.

```bash
cd services/name-origin

# Create virtual environment
python -m venv .venv
source .venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Start the service
python main.py
# → Running at http://localhost:5050
```

**Health check:**
```bash
curl http://localhost:5050/health
```

Leave this terminal open, then return to the main `genlea/` directory.

---

## Step 6 — Start the Workers

In a new terminal:

```bash
cd /Users/rac/Desktop/pp/genlea
npm run workers
```

You should see:
```
[workers] Starting all GenLea workers...
[discovery.worker] Worker started
[enrichment.worker] Worker started
[scoring.worker] Worker started
[workers] All workers running — waiting for jobs
```

---

## Step 7 — Start the API Server

In another new terminal:

```bash
npm run api
# → API started at http://localhost:4000
```

---

## Step 8 — Seed & Run First Scrape

### Option A — Seed all queues at once (recommended first run)

```bash
npm run seed
```

This enqueues 10 discovery jobs across Wellfound, LinkedIn, Crunchbase, and Apollo.
Watch the workers terminal — jobs will start processing immediately.

### Option B — Trigger a single manual scrape

```bash
# Via CLI
npm run scrape -- --source wellfound --query "nodejs backend startup US"

# Or via API
curl -X POST http://localhost:4000/api/scrape \
  -H 'Content-Type: application/json' \
  -d '{"source":"wellfound","query":{"keywords":"nodejs startup US"},"limit":20}'
```

---

## Step 9 — Monitor Progress

### Queue status
```bash
curl http://localhost:4000/api/jobs/status | jq
```

Or open **Bull Board** at http://localhost:3001

### Scrape logs
```bash
curl http://localhost:4000/api/jobs/logs | jq
```

### Database counts
```bash
curl http://localhost:4000/api/stats | jq
```

---

## Step 10 — View Leads & Export

### See hot leads (score ≥ 65)
```bash
curl "http://localhost:4000/api/leads?status=hot&limit=20" | jq
```

### Filter by tech stack
```bash
curl "http://localhost:4000/api/leads?status=hot&techStack=nodejs&techStack=react" | jq
```

### Export to CSV
```bash
curl "http://localhost:4000/api/export/csv?status=hot" -o leads.csv
# File also saved automatically to: exports/leads-hot-{timestamp}.csv
```

---

## LinkedIn Session Setup (for LinkedIn scraper)

LinkedIn requires warm cookie sessions — do this before running the LinkedIn scraper:

```bash
# Log in and save session cookies
npm run scrape -- --source linkedin --login
```

This opens a browser, logs in with `LI_USERNAME`/`LI_PASSWORD` from `.env`, and saves cookies to `sessions/linkedin/`.

**After setup:**
- Sessions are auto-rotated
- Max 80 profiles/session/day (controlled by `LI_MAX_PROFILES_PER_SESSION`)
- Cooldown: 8h after daily limit (controlled by `LI_SESSION_COOLDOWN_HOURS`)

---

## Running Everything at Once (Dev Mode)

```bash
# Starts workers + API in watch mode (auto-restarts on file change)
npm run dev
```

---

## Scraper Mode Reference

| Scraper | Without API Key | With API Key |
|---|---|---|
| LinkedIn | ✅ Playwright stealth (cookies required) | N/A |
| Wellfound | ✅ Playwright (no auth needed) | N/A |
| Crunchbase | ✅ Playwright web scraping | ✅ REST API |
| Apollo | ✅ Playwright web scraping (limited) | ✅ REST API |
| Hunter.io | ⚠️ Only `findEmail` fallback | ✅ REST API |
| GitHub | ✅ Unauthenticated (60 req/hr) | ✅ Auth (5000 req/hr) |
| ZoomInfo | ✅ Playwright stealth (login required) | N/A |

---

## Troubleshooting

### MongoDB not connecting
```bash
docker-compose ps                    # check if mongo is running
docker-compose logs mongo            # view logs
docker-compose restart mongo         # restart if stuck
```

### Redis not connecting
```bash
docker-compose ps
docker-compose logs redis
redis-cli ping                       # should return PONG
```

### LinkedIn CAPTCHA / session blocked
```bash
# Check session status
curl http://localhost:4000/api/jobs/logs?scraper=linkedin | jq

# Re-login a session
npm run scrape -- --source linkedin --login
```

### Bull Board showing failed jobs
1. Open http://localhost:3001
2. Click the failed queue
3. Check the error trace — it includes `[worker] Job failed` + full error
4. Fix and re-run: click "Retry" on individual jobs

### Workers not processing
```bash
# Check Redis is reachable
redis-cli ping

# Restart workers
npm run workers
```

---

## File Map

```
genlea/
├── .env                    ← Your credentials (edit this)
├── docker-compose.yml      ← Infrastructure (start this first)
├── src/
│   ├── scrapers/           ← LinkedIn, Crunchbase, Apollo, Hunter, GitHub, Wellfound
│   ├── core/               ← Browser pool, proxy, session, queue
│   ├── enrichment/         ← Normalizer, origin analyzer
│   ├── scoring/            ← 0–100 lead scorer
│   ├── workers/            ← BullMQ workers (start with npm run workers)
│   ├── storage/            ← MongoDB repositories
│   └── api/                ← Fastify REST API (start with npm run api)
├── services/name-origin/   ← Python classifier (optional, start separately)
├── sessions/               ← LinkedIn cookies (auto-managed)
├── exports/                ← CSV exports land here
└── ARCHITECTURE.md         ← Full system design
```
