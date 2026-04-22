# GenLea — Getting Started

---

## Prerequisites

| Tool | Version |
|---|---|
| Node.js | ≥ 20 LTS |
| Docker Desktop | Latest |
| Python | ≥ 3.10 (name-origin service only) |
| Ollama | Latest |

---

## Step 1 — Install dependencies

```bash
cd genlea-backend
npm install
```

---

## Step 2 — Configure environment

The `.env` file is already created. Open it and fill in your credentials.

**Minimum to run (no paid APIs):**
```env
MONGO_URI=mongodb://localhost:27017   # already set
REDIS_URL=redis://localhost:6379      # already set
```

**Recommended to unlock full pipeline:**
```env
EXPLORIUM_API_KEY=...   # best discovery + enrichment source
HUNTER_API_KEY=...      # email discovery (25 free/month)
GITHUB_TOKEN=...        # tech stack extraction (5000 req/hr vs 60 without)
```

**Ollama performance (already set in .env):**
```env
OLLAMA_NUM_CTX=8192      # reduces RAM from ~6GB to ~1.5GB per inference
OLLAMA_NUM_PREDICT=1024
OLLAMA_KEEP_ALIVE=5m     # unloads model after 5 min idle
```

---

## Step 3 — Start MongoDB + Redis

```bash
docker-compose up -d mongo redis
```

Verify:
```bash
docker-compose ps
```

**Useful UIs after this step:**
| URL | Purpose |
|---|---|
| http://localhost:8081 | Mongo Express — browse collections |
| http://localhost:4001/queues | Bull Board — monitor job queues |

---

## Step 4 — Init the database (run once)

```bash
npm run db:init
```

---

## Step 5 — Pull + serve the Ollama model

```bash
ollama pull qwen3.5      # one-time download (~5GB)
ollama serve             # keep this running
```

Skip this step if using `AGENT_LLM_PROVIDER=groq` or `anthropic`.

---

## Step 6 — (Optional) Start the name-origin microservice

More accurate South-Asian origin detection than the rule-based fallback.

```bash
cd services/name-origin
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python main.py
# → http://localhost:5050
```

Set in `.env`:
```env
NAME_ORIGIN_PROVIDER=ethnicolr
ETHNICOLR_URL=http://localhost:5050
```

---

## Step 7 — Start the engine

```bash
# Workers + API together (recommended)
npm run dev

# Or separately:
npm run workers   # discovery + enrichment + scoring workers
npm run api       # Fastify REST API on :4001
```

Log output:
```
[discovery.worker] Worker started (agent mode) { concurrency: 1 }
[enrichment.worker] Worker started (agent mode) { concurrency: 1 }
[scoring.worker] Worker started { concurrency: 30 }
[api] Listening at http://0.0.0.0:4001
```

Discovery and enrichment concurrency is capped to 1 when `AGENT_LLM_PROVIDER=ollama` — prevents Ollama from being overwhelmed with parallel inference requests.

---

## Step 8 — Start the frontend

```bash
cd ../genlea-frontend
npm install
npm run dev
# → http://localhost:3000
```

---

## Step 9 — Seed the pipeline

```bash
npm run seed          # 1 round (~48 discovery jobs)
npm run seed:10       # 10 rounds
npm run seed:100      # 100 rounds — full bulk run
```

Watch progress in the genlea-frontend dashboard or Bull Board.

---

## Development tips

### Don't run everything at once

Stagger memory peaks by running services one at a time:

```bash
docker-compose up -d mongo redis             # always on
npm run api                                   # always on (need dashboard)

npm run workers                               # run, let discovery seed the queue
# once queue builds up — can Ctrl+C workers and re-run to process enrichment
```

The queues persist in Redis — jobs survive worker restarts.

### Slow laptop during a run

If Ollama is stalling your machine:
1. Drop browser concurrency: `MAX_CONCURRENT_BROWSERS=1` in `.env`
2. Use Groq instead: set `AGENT_LLM_PROVIDER=groq` (needs `GROQ_API_KEY`)
3. Try a lighter model: `AGENT_LLM_MODEL=qwen3:4b` in `.env`

---

## Common npm scripts

| Command | What |
|---|---|
| `npm run dev` | Start workers + API in watch mode |
| `npm run workers` | Workers only |
| `npm run api` | API only |
| `npm run seed:100` | Push 100 rounds of discovery jobs |
| `npm run login` | Log in to LinkedIn and save session cookies |
| `npm run stats` | Print lead counts by status |
| `npm run export` | Export hot leads to `exports/leads-export.csv` |
| `npm run rescore-all` | Re-score all companies (use after threshold changes) |
| `npm run verify-emails` | SMTP-verify up to 500 unverified emails |
| `npm run db:init` | Create MongoDB indexes (run once) |
| `npm run build` | TypeScript type-check |

---

## Troubleshooting

### MongoDB not connecting
```bash
docker-compose ps
docker-compose logs mongo
docker-compose restart mongo
```

### Workers not picking up jobs
```bash
redis-cli ping          # should return PONG
npm run workers         # restart
```

### LinkedIn CAPTCHA / session blocked
```bash
npm run login           # re-authenticate and save fresh cookies
```

### Failed jobs in Bull Board
Open http://localhost:4001/queues, click the failed queue, check the error trace, then click Retry.
