# genlea — Claude Code Instructions

B2B lead-gen engine. Scrapes US tech companies, extracts CEO/HR contacts, scores leads 0–100.
Stack: Node.js 20, TypeScript strict, Playwright, BullMQ, MongoDB, Fastify.

---

## Architecture

Three-stage BullMQ pipeline:

```
Scheduler (cron every 2h)
  → discovery queue    → discovery.worker   → normalize → dedup → filter → upsert → enrichment queue
  → enrichment queue   → enrichment.worker  → GitHub + Clearbit + website-team + Hunter + contact resolver → scoring queue
  → scoring queue      → scoring.worker     → score 0–100 → updateScore
```

Workers live in `src/workers/`. Each has a single responsibility — don't merge concerns across workers.

---

## Key Files

| File | Purpose |
|---|---|
| `src/core/queue.manager.ts` | BullMQ queues: discovery / enrichment / scoring |
| `src/core/scheduler.ts` | Cron every 2h + startup seed + nightly stale cleanup |
| `src/core/browser.manager.ts` | Playwright stealth pool |
| `src/scoring/rules.ts` | All 5 scoring signals and their weights |
| `src/scoring/scorer.ts` | Orchestrates scoring |
| `src/storage/mongo.client.ts` | MongoDB connection — all DB access goes through repositories |
| `src/storage/repositories/` | company, contact, job, scrape-log, settings repos |
| `src/enrichment/contact.resolver.ts` | Email verification + Hunter gap-fill |
| `src/enrichment/website-team.enricher.ts` | Scrapes /team and /about pages for employee names |
| `src/utils/groq.client.ts` | Groq AI client |
| `src/utils/helpers.ts` | normalizeDomain, normalizeEmail, etc. (file still named random.ts) |
| `src/api/dashboard.ts` | Inline HTML dashboard — single file |

---

## Scoring Weights

| Signal | Max pts | Notes |
|---|---|---|
| originRatio | 30 | unknown → 10 (neutral, not 0) |
| jobFreshness | 20 | active jobs with postedAt |
| techStack | 20 | TARGET_TAGS env var |
| contactScore | 15 | CEO/HR email + verification |
| companyFit | 15 | size 30–200 ideal, funding stage |

Thresholds (defaults): hot ≥ 55, warm ≥ 38, minSample = 5.

---

## Rules — Never Break These

- **Repositories only touch MongoDB** — nothing outside `src/storage/repositories/` calls mongo directly
- **manuallyReviewed flag** — scoring never overwrites statuses set by user
- **24h enrichment cooldown** — skip if `lastEnrichedAt` < 24h ago (force=true bypasses)
- **Enterprise blocklist** — ~32 domains blocked at discovery (google.com, amazon.com, etc.)
- **Size guard** — companies with >1000 employees skip enrichment, auto-disqualify
- **Tech filter** — skip companies with 0 tech tags from both company + jobs sources
- **lastScrapedAt** only updates when actually scraping, not on every upsert

---

## Scrapers — Adding a New One

1. Create file in `src/scrapers/discovery/` or `src/scrapers/enrichment/`
2. Implement the scraper interface (check existing scrapers for shape)
3. Add `isAvailable()` — must return `false` if required API key/credential is missing
4. Export from `src/scrapers/discovery/index.ts` or enrichment barrel
5. Do NOT modify existing scrapers or the worker logic

Follows Open/Closed — new scrapers extend the system, existing code untouched.

---

## Known Quirks

- `src/utils/helpers.ts` is still named `random.ts` on disk — don't rename without updating all imports
- Apollo and Crunchbase scrapers require API keys — `isAvailable()` returns false without them
- GitHub contributor count is NOT stored as employeeCount
- CSV export uses a single `$in` batch query — don't revert to parallel queries
- `disqualify()` is a dedicated method — don't use upsert for disqualification (status gets ignored)

---

## Dev Commands

```bash
npm run dev          # ts-node-dev watch
npm run build        # tsc
npm run lint         # eslint
npm test             # jest
```

Env: copy `.env.example`, set `MONGO_URI`, `TARGET_TAGS`, optional API keys.
