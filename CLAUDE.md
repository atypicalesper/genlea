# genlea — Claude Code Instructions

B2B lead-gen engine. Scrapes US tech companies, extracts CEO/HR contacts, scores leads 0–100.
Stack: Node.js 20, TypeScript strict, Playwright, BullMQ, MongoDB, Fastify.

---

## Architecture

```
Scheduler (cron every 2h)
  → discovery queue    → discovery.worker   → normalize → dedup → filter → upsert → enrichment queue
  → enrichment queue   → enrichment.worker  → GitHub + Clearbit + website-team + Hunter + contact resolver → scoring queue
  → scoring queue      → scoring.worker     → score 0–100 → updateScore
```

Workers live in `src/workers/`. Each has a single responsibility.

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
- **New scrapers**: create in `src/scrapers/discovery/` or `enrichment/`, implement `Scraper` interface, add `isAvailable()`, export from barrel — never modify existing scrapers or worker logic

---

## Key Patterns

### Scraper Interface
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
const proxy = proxyManager.getProxy();
const context = await browserManager.createContext(browserId, { proxy, cookiesPath });
const page = await browserManager.newPage(context);
await browserManager.humanDelay(2000, 6000);
await browserManager.humanScroll(page, 5);
```

### Queue Jobs
```ts
await queueManager.addDiscoveryJob({ runId, source, query });
await queueManager.addEnrichmentJob({ runId, companyId, domain, sources });
await queueManager.addScoringJob({ runId, companyId });
```

### Repository Upsert
```ts
// domain is normalized before upsert (lowercase, strip www., strip /)
await companyRepository.upsert(normalizedCompany);
```

### Logger
```ts
logger.info({ scraper: 'linkedin', company: 'acme.com', runId }, 'Scraped company');
logger.warn({ accountId, reason: 'captcha' }, 'Session paused');
logger.error({ err, domain }, 'Failed to scrape');
```

---

## MongoDB Schema

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

## Anti-Detection Rules

| Rule | Value |
|---|---|
| Max profiles/LinkedIn session/day | 80 (`LI_MAX_PROFILES_PER_SESSION`) |
| Delay between navigations | 2–8s randomized |
| Max concurrent browsers | 3 (`MAX_CONCURRENT_BROWSERS`) |
| Session cooldown after limit | 8h (`LI_SESSION_COOLDOWN_HOURS`) |
| Proxy | Always rotate residential proxies |
| Resource blocking | Block images, fonts, ads, tracking pixels |
| Fingerprint | Spoof webdriver, plugins, WebGL, canvas |

---

## Known Quirks

- `src/utils/helpers.ts` is still named `random.ts` on disk — don't rename without updating all imports
- Apollo and Crunchbase scrapers require API keys — `isAvailable()` returns false without them
- GitHub contributor count is NOT stored as employeeCount
- CSV export uses a single `$in` batch query — don't revert to parallel queries
- `disqualify()` is a dedicated method — don't use upsert for disqualification (status gets ignored)

