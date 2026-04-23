# GenLea — Architecture

> B2B lead-gen engine for software-services outreach. Discovers non-India companies in higher-paying markets that are hiring engineers, show Indian-origin team signals, and have decision-maker contacts.

---

## System overview

```mermaid
flowchart LR
  scheduler["Scheduler / Manual Seed"] --> discoveryQueue["BullMQ: genlea-discovery"]
  discoveryQueue --> discoveryWorker["Discovery Worker"]
  discoveryWorker --> companies[("MongoDB: companies")]
  discoveryWorker --> jobs[("MongoDB: jobs")]
  discoveryWorker --> scrapeLogs[("MongoDB: scrape_logs")]
  discoveryWorker --> enrichmentQueue["BullMQ: genlea-enrichment"]
  enrichmentQueue --> enrichmentWorker["Enrichment Worker"]
  enrichmentWorker --> companies
  enrichmentWorker --> contacts[("MongoDB: contacts")]
  enrichmentWorker --> jobs
  enrichmentWorker --> scoringQueue["BullMQ: genlea-scoring"]
  scoringQueue --> scoringWorker["Scoring Worker"]
  scoringWorker --> companies
  companies --> api["Fastify API"]
  contacts --> api
  jobs --> api
  api --> frontend["Frontend / CSV Export"]
```

All state lives in MongoDB. Queues are Redis-backed (BullMQ). Workers are stateless — you can run multiples.

---

## Journey of a Lead

This is the full lifecycle of one company from “raw search result” to “pitchable lead” or “disqualified lead.”

```mermaid
flowchart TD
  seed["Seed query or manual scrape<br/>keywords + source + premium-market location"] --> dq["Discovery queue job"]
  dq --> da["Discovery agent starts<br/>get_discovery_state"]
  da --> scrape["scrape_source<br/>Wellfound / Indeed / Glassdoor / LinkedIn / ATS / API source"]
  scrape --> raw["RawResult[]<br/>company, jobs, contacts, diagnostics"]
  raw --> normalize["normalizer.processResults<br/>canonical domains, names, tech tags"]
  normalize --> dedupe["deduplicateCompanies<br/>domain first, name fallback"]
  dedupe --> filter{"Early discovery filters"}

  filter -->|blocked enterprise / staffing / junk| drop["Drop before DB"]
  filter -->|India HQ known| drop
  filter -->|employeeCount > 1000| drop
  filter -->|valid enough| resolve["Resolve identity<br/>existing domain → URL hints → name lookup → unresolved"]

  resolve --> resolved{"Domain resolved?"}
  resolved -->|yes + hiring source| discovered["pipelineStatus=discovered"]
  resolved -->|no or weak signal| watchlist["pipelineStatus=watchlist"]

  discovered --> upsert["companyRepository.upsert"]
  watchlist --> upsert
  upsert --> saveJobs["Persist scraped jobs<br/>jobRepository.upsert"]
  upsert --> hunterPrepop["Best-effort Hunter pre-pop<br/>non-blocking if key exists"]
  saveJobs --> enrichQ{"Queue enrichment?"}
  hunterPrepop --> enrichQ

  enrichQ -->|resolved + hiring evidence| eq["Enrichment queue"]
  enrichQ -->|unresolved/watchlist| wait["Wait for review or later resolver"]

  eq --> ea["Enrichment agent starts<br/>get_company_state"]
  ea --> guard{"Fast guards"}
  guard -->|employeeCount > 1000| disqSize["disqualified<br/>too large"]
  guard -->|recently enriched and not forced| scoreQ1["Queue scoring directly"]
  guard -->|needs enrichment| progress["check_enrichment_progress"]

  progress --> github["enrich_github<br/>tech stack + contributor names"]
  progress --> team["scrape_website_team<br/>team/about names + roles"]
  progress --> hunter["enrich_hunter<br/>decision-maker emails"]
  progress --> hiring["check_company_hiring<br/>LinkedIn / Wellfound / Indeed / Glassdoor / SurelyRemote"]
  progress --> playwright["playwright_scrape_url<br/>careers/team/contact/company pages"]

  github --> names["Name pool for origin ratio"]
  team --> names
  playwright --> names
  hunter --> contacts["Decision-maker contacts"]
  hiring --> jobsDb["Active engineering jobs"]
  playwright --> defunct{"Defunct / parked / unreachable?"}
  defunct -->|yes| disqDead["disqualified<br/>dead or parked site"]
  defunct -->|no| progress

  names --> origin{"Enough names?"}
  origin -->|yes| ratio["compute_origin_ratio<br/>Indian-origin signal"]
  origin -->|no| progress
  contacts --> progress
  jobsDb --> progress
  ratio --> scoreQ2["Queue scoring"]

  scoreQ1 --> scoring["Scoring worker"]
  scoreQ2 --> scoring
  scoring --> hardGate{"Hard ICP gates"}
  hardGate -->|India HQ| disqIndia["disqualified<br/>India headquartered"]
  hardGate -->|too large| disqLarge["disqualified<br/>enterprise size"]
  hardGate -->|no engineering hiring signal| disqHiring["disqualified<br/>no hiring signal"]
  hardGate -->|no India-team signal| disqOrigin["disqualified<br/>no Indian-origin signal"]
  hardGate -->|passes gates| score["Score 0-100<br/>origin + jobs + tech + contacts + fit"]
  score --> status{"Status resolver"}
  status --> hv["hot_verified"]
  status --> hot["hot"]
  status --> warm["warm"]
  status --> cold["cold"]
  status --> low["disqualified<br/>below threshold"]

  hv --> ui["Leads UI / CSV export"]
  hot --> ui
  warm --> ui
  cold --> ui
  low --> ui
  disqSize --> ui
  disqDead --> ui
  disqIndia --> ui
  disqLarge --> ui
  disqHiring --> ui
  disqOrigin --> ui
```

### Lead State Machine

`pipelineStatus` tracks where the record is in the processing lifecycle. `status` tracks whether it is worth outreach.

```mermaid
stateDiagram-v2
  [*] --> discovered: resolved company from hiring source
  [*] --> watchlist: unresolved domain or weak evidence
  watchlist --> discovered: later domain/hiring evidence found
  discovered --> enriching: enrichment job starts
  enriching --> enriched: data gathered
  enriching --> scoring: cooldown or best-effort fallback
  enriched --> scoring: queue_for_scoring
  scoring --> scored: updateScore persisted
  scored --> discovered: manual re-enrich
  scored --> scoring: manual rescore

  state scored {
    [*] --> pending
    pending --> hot_verified
    pending --> hot
    pending --> warm
    pending --> cold
    pending --> disqualified
    hot_verified --> disqualified: manual override or new hard gate
    hot --> disqualified: manual override or new hard gate
    warm --> disqualified: manual override or new hard gate
    cold --> disqualified: manual override or new hard gate
  }
```

### Data Written Along the Way

```mermaid
flowchart LR
  discovery["Discovery"] --> companyFields["companies<br/>name, domain, sources, techStack, employeeCount, funding, hqCountry, pipelineStatus"]
  discovery --> jobFields["jobs<br/>title, source, sourceUrl, techTags, postedAt, isActive"]
  discovery --> scrapeFields["scrape_logs<br/>source, outcome, diagnostics, counts"]

  enrichment["Enrichment"] --> companyFields2["companies<br/>websiteUrl, githubOrg, openRoles, originRatio, originDevCount, totalDevCount, lastEnrichedAt"]
  enrichment --> contactFields["contacts<br/>decision-makers, emails, confidence, LinkedIn, origin-ratio names"]
  enrichment --> jobFields2["jobs<br/>hiring-check roles from multiple sources"]

  scoring["Scoring"] --> scoreFields["companies<br/>score, scoreBreakdown, status, disqualificationReason, openRoles"]
```

### Why a Lead Can Be Rejected

```mermaid
flowchart TD
  candidate["Candidate company"] --> india{"India HQ?"}
  india -->|yes| rejectIndia["Reject: outside target market"]
  india -->|no / unknown| size{"Too large?<br/>employeeCount > 1000 or totalDevCount > 250"}
  size -->|yes| rejectSize["Reject: enterprise / too large"]
  size -->|no / unknown| hiring{"Engineering hiring signal?"}
  hiring -->|no| rejectHiring["Reject: no active engineering hiring evidence"]
  hiring -->|yes| origin{"Indian-origin employee signal?"}
  origin -->|no| rejectOrigin["Reject: no India-team signal"]
  origin -->|yes| contacts{"Decision-maker contacts?"}
  contacts -->|yes| qualify["Score and rank for outreach"]
  contacts -->|no| nurture["Score lower / enrich again later"]
```

The scoring worker keeps disqualification reasons explicit so the frontend can show why a lead failed instead of only showing `disqualified`.

---

## Directory structure

```
genlea-backend/
├── src/                         — main entry point (monolith workers + API)
│   ├── agents/                  — LLM agent entrypoints for discovery + enrichment
│   ├── api/                     — Fastify REST API + Bull Board + inline dashboard
│   ├── core/                    — browser pool, queue manager, proxy/session managers
│   ├── discovery/               — blocklists, source health tracking
│   ├── enrichment/              — normalizer, deduplicator, email verifier, contact resolver
│   ├── scoring/                 — rules.ts + scorer.ts
│   ├── scrapers/                — one file per source (discovery/ and enrichment/ subdirs)
│   ├── storage/                 — MongoDB client + repositories
│   ├── types/                   — shared TypeScript types (monolith)
│   ├── utils/                   — logger, helpers, LLM client
│   └── workers/                 — discovery.worker, enrichment.worker, scoring.worker
│
├── packages/
│   └── shared/                  — @genlea/shared: types, repos, queue, agent framework
│       └── src/
│           ├── agent/           — dom-summarizer, memory, planner, executor, agent-loop
│           ├── enrichment/      — normalizer, deduplicator
│           ├── storage/         — repositories (re-exported)
│           ├── utils/           — llm.client, logger
│           └── scheduler.ts     — seed queries + enqueueSeedRound
│
├── services/                    — standalone microservice versions (WIP)
│   ├── svc-discovery/
│   ├── svc-enrichment/
│   ├── svc-scoring/
│   ├── svc-api/
│   └── name-origin/             — Python FastAPI origin classifier (port 5050)
│
├── scripts/                     — db-init, seed-queries, rescore-all, verify-emails
├── docker-compose.yml
└── .env
```

The active entry point is `src/`. The `services/` tree is an in-progress split — not yet the primary runner.

---

## Key files

| File | Purpose |
|---|---|
| `src/workers/index.ts` | Starts all 3 workers |
| `src/api/server.ts` | Fastify server — REST API + Bull Board |
| `src/core/queue.manager.ts` | BullMQ queues: discovery / enrichment / scoring |
| `src/core/scheduler.ts` | Cron every 2h + startup seed + nightly stale cleanup |
| `src/core/browser.manager.ts` | Playwright stealth pool |
| `src/agents/discovery.agent.ts` | LLM-driven discovery loop |
| `src/agents/enrichment.agent.ts` | LLM-driven enrichment loop |
| `src/agents/enrichment-tools.ts` | Tool registry for enrichment agent |
| `src/scoring/rules.ts` | All 5 scoring signals and weights |
| `src/scoring/scorer.ts` | Orchestrates scoring |
| `src/storage/mongo.client.ts` | MongoDB connection singleton |
| `src/storage/repositories/` | company, contact, job, scrape-log, settings repos |
| `src/enrichment/contact.resolver.ts` | Email verification + Hunter gap-fill |
| `src/enrichment/website-team.enricher.ts` | Scrapes /team and /about pages |
| `src/utils/llm.client.ts` | Builds LangChain model (Ollama/Groq/Anthropic) |
| `packages/shared/src/utils/llm.client.ts` | Shared LLM client with Groq→Ollama fallback |

---

## Pipeline

### Phase 1 — Discovery

```
Seed query (keywords, location, source)
  → scraper.scrape(query)           — returns RawResult[]
  → normalizer.processResults()     — standardize fields, strip www., lowercase domain
  → deduplicateCompanies()          — merge duplicates in batch
  → filter pass (silent drops):
      missing domain/name
      no tech signal (no techStack, no job tech tags)
      blocked enterprise domain
      India HQ
      name matches bank/govt/consulting pattern
      employeeCount > 1000
  → companyRepository.upsert()
  → contactRepository / jobRepository.upsert() (parallel)
  → queueManager.addEnrichmentJob()
```

### Phase 2 — Enrichment

```
enrichment.agent.ts (LLM ReAct loop via @genlea/shared agent framework)
  ├── guard: employeeCount > 1000 → disqualify, stop
  ├── guard: enriched < 7 days → skip to scoring (unless force=true)
  ├── GitHub scraper         — tech stack, contributor names
  ├── website-team.enricher  — Playwright: /team, /about, /company pages
  ├── check_company_hiring   — verifies active engineering jobs from hiring sources
  ├── defunct check          — DNS fail, HTTP 404, parked page, shutdown language → disqualify
  ├── Hunter.io              — email pattern + domain search
  ├── contact.resolver       — SMTP verify + CEO/HR gap-fill
  ├── origin ratio analysis  — name-origin service → indianDevRatio
  └── queueManager.addScoringJob()
```

### Phase 3 — Scoring

```
scorer.ts (5 signals, 0–100 total)
  ├── originRatio     — 0–30 pts
  ├── jobFreshness    — 0–20 pts
  ├── techStack       — 0–20 pts
  ├── contactQuality  — 0–15 pts
  └── companyFit      — 0–15 pts

→ status: hot_verified (≥80) / hot (≥65) / warm (≥50) / cold (≥35) / disqualified (<35)
→ hard ICP gates: India HQ, enterprise size, missing engineering hiring, missing India-team signal
```

---

## LLM / Agent

Workers that call the LLM: discovery.agent.ts, enrichment.agent.ts.

When `AGENT_LLM_PROVIDER=ollama`, both workers are **capped at concurrency 1** — Ollama serializes inference anyway, and parallel jobs just waste RAM holding idle BullMQ workers.

Context window is set to `8192` in `.env` (down from the `32768` framework default) to keep inference within ~1.5GB VRAM instead of ~6GB.

See [AGENT_FRAMEWORK.md](AGENT_FRAMEWORK.md) for the full agent architecture.

---

## Worker concurrency

| Worker | Default (DB) | Ollama cap | What it runs |
|---|---|---|---|
| discovery | 10 | 1 | LLM agent + Playwright scrapers |
| enrichment | 15 | 1 | LLM agent + API scrapers + Playwright |
| scoring | 30 | none | Pure rule engine, no LLM |

Concurrency is live-adjustable via `PATCH /api/settings` — workers poll every 10 seconds.

---

## MongoDB schema

### `companies`
```ts
{ name, domain (unique), linkedinUrl, employeeCount, indianDevCount, totalDevCount,
  indianDevRatio, toleranceIncluded, fundingStage, techStack[], openRoles[], sources[],
  score (0-100), scoreBreakdown{...}, status ('hot_verified'|'hot'|'warm'|'cold'|'disqualified'),
  disqualificationReason?, pipelineStatus, manuallyReviewed,
  createdAt, updatedAt, lastScrapedAt, lastEnrichedAt }
```

### `contacts`
```ts
{ companyId, role ('CEO'|'CTO'|'HR'|'Recruiter'|...), fullName, email, emailVerified,
  emailConfidence (0-1), phone, linkedinUrl, isIndianOrigin, sources[], createdAt }
```

### `jobs`
```ts
{ companyId, title, techTags[], source, sourceUrl, postedAt, isActive, scrapedAt }
```

### `scrape_logs`
```ts
{ runId, scraper, status, companiesFound, contactsFound, errors[], durationMs,
  startedAt, completedAt, agentSteps?, diagnostics? }
```

### `settings` (single doc, `_id: 'global'`)
```ts
{ originRatioThreshold, originRatioMinSample, targetTechTags[], highValueIndustries[],
  leadScoreHotVerifiedThreshold, leadScoreHotThreshold, leadScoreWarmThreshold, leadScoreColdThreshold,
  workerConcurrencyDiscovery, workerConcurrencyEnrichment, workerConcurrencyScoring }
```

---

## Anti-detection

| Setting | Value |
|---|---|
| Max LinkedIn profiles/session/day | 80 (`LI_MAX_PROFILES_PER_SESSION`) |
| Delay between navigations | 2–8s randomized |
| Max concurrent browsers | 10 (`MAX_CONCURRENT_BROWSERS`) — set to 1 on dev laptop |
| Session cooldown after limit | 8h (`LI_SESSION_COOLDOWN_HOURS`) |
| Proxy | Residential rotating (`PROXY_PROVIDER=brightdata`) |
| Resource blocking | Images, fonts, ads, tracking pixels |

---

## Rules — never break

- Repositories only touch MongoDB — no mongo calls outside `src/storage/repositories/`
- `manuallyReviewed` flag — scoring never overwrites statuses set by user
- 7-day enrichment cooldown — skip if `lastEnrichedAt` < 7 days (bypass: `force=true`)
- Enterprise blocklist — ~80 domains blocked at discovery
- Size guard — `employeeCount > 1000` → disqualify at both discovery and enrichment
- Tech filter — skip companies with 0 tech tags from both company + jobs sources
- `lastScrapedAt` only updates when actually scraping, not on every upsert
- `disqualify()` is a dedicated method — never use `upsert()` for disqualification
