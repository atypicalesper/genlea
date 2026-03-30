# GenLea — Local Knowledge Base
> Decisions made, gotchas found, patterns established. Update this as you discover things.
> Location: `/Users/rac/Desktop/pp/genlea/.claude/KNOWLEDGE.md`

---

## Architecture Decisions

### Why education signals over name matching for talent origin detection
**Decision (2026-03-30):** The `services/name-origin` microservice was rewritten to detect South Asian developer background via LinkedIn education history (IIT, NIT, BITS Pilani, etc.) and past location signals rather than surname/first-name lookup tables.

**Rationale:**
- Name lists have ~30–40% false positive rate (e.g., "Arjun" can be Sri Lankan, "Patel" appears in UK/Africa contexts)
- Education signal is definitive — an IIT Bombay grad is unambiguously Indian-origin
- Location history ("Previously: Bengaluru, India") is also high-confidence
- ethnicolr ML model is kept only as a **supplementary signal**, never the sole reason
- Combined multi-signal approach: education + location + ML → boosted confidence

### Why `domain` is the canonical dedup key (not company name or LinkedIn ID)
- Company names change (acquisition, rebrand), LinkedIn slugs change, but domain is stable
- All repositories deduplicate on normalized domain: lowercase, `www.` stripped, no trailing slash
- `normalizeDomain()` in `src/utils/random.ts` is the single normalizer — always use it

### Why BullMQ over simple async loops
- LinkedIn scraping can be paused mid-run (CAPTCHA, cooldown) — queues survive restarts
- Retry with backoff is built-in — no manual error loop management
- Phase separation (discovery → enrichment → scoring) means each step is independently resumable

### Why Fastify over Express for the API
- Native async support, much better TypeScript types
- Schema-based validation built-in (pairs well with Zod)
- ~2x throughput vs Express under load

### Why two separate git repos (main engine + name-origin service)
- The Python microservice has a completely different runtime and can be deployed independently (e.g., on a cheaper Python container or serverless)
- Allows independent version bumps and language-specific CI pipelines

---

## Naming Conventions

### Professional field names (do NOT use "indian" in code)
| Concept | Field Name |
|---|---|
| Ratio of South Asian devs | `originRatio` |
| Count of South Asian devs | `originDevCount` |
| Total devs analysed | `totalDevCount` |
| Company flag for tolerance mode | `toleranceIncluded` |
| Env var for threshold | `ORIGIN_RATIO_THRESHOLD` |
| Analyser file | `dev-origin.analyzer.ts` |
| Python service | `services/name-origin/` |

### Scraper naming
```
src/scrapers/{source}.scraper.ts
```
Examples: `linkedin.scraper.ts`, `apollo.scraper.ts`, `crunchbase.scraper.ts`

### Worker naming
```
src/workers/{phase}.worker.ts
```
Examples: `discovery.worker.ts`, `enrichment.worker.ts`, `scoring.worker.ts`

---

## Gotchas & Known Issues

### LinkedIn anti-scraping
- **Never** use headless=true with default Playwright flags — LinkedIn detects it in ~5 requests
- The `STEALTH_INIT_SCRIPT` in `browser.manager.ts` must run on EVERY page (via `addInitScript`)
- Always block images/fonts/tracking via `page.route()` — reduces fingerprint surface
- "People" tab on company page only shows ~10 results unless you scroll slowly
- LinkedIn limits the People tab to ~1,000 visible employees even for large companies

### Session management
- LinkedIn sessions expire in ~30 days even if actively used
- After a CAPTCHA → mark session as blocked immediately via `sessionManager.markBlocked()`
- Never reuse a session across multiple parallel browser contexts simultaneously

### MongoDB upsert race conditions
- Discovery and enrichment workers can upsert the same company simultaneously
- MongoDB `$addToSet` and `$max` on the update are atomic — safe for concurrent upserts
- Do NOT use `findOne` + `replaceOne` pattern — use the `upsert()` method in the repository

### Redis / BullMQ
- Jobs that fail 3 times go to the `failed` set — check Bull Board UI at `localhost:3001`
- Stalled jobs (worker died mid-processing) get re-queued automatically after 30s
- Always call `await worker.close()` on SIGTERM to prevent job loss

### Email verification
- Hunter.io free tier: 25 verifications/month — use sparingly, only for HOT leads
- SMTP verification can trigger spam filters — always do MX check first
- Gmail/Google Workspace addresses: SMTP verify often returns false negatives
- Treat any `emailConfidence < 0.70` as unverified

---

## Scraper Status Log

| Scraper | Status | Notes |
|---|---|---|
| `linkedin.scraper.ts` | ❌ Not built | Priority 1 |
| `crunchbase.scraper.ts` | ❌ Not built | Priority 2 |
| `apollo.scraper.ts` | ❌ Not built | Priority 3 |
| `hunter.scraper.ts` | ❌ Not built | Priority 3 |
| `github.scraper.ts` | ❌ Not built | Priority 4 |
| `clearbit.scraper.ts` | ❌ Not built | Priority 4 |
| `wellfound.scraper.ts` | ❌ Not built | Priority 5 |
| `zoominfo.scraper.ts` | ❌ Not built | Priority 5 |
| `sales-navigator.scraper.ts` | ❌ Not built | Requires paid account |

---

## Environment Quick Reference

| Var | Dev Default | Purpose |
|---|---|---|
| `ORIGIN_RATIO_THRESHOLD` | `0.60` | Min South Asian dev ratio to include company |
| `LEAD_SCORE_HOT_THRESHOLD` | `65` | Min score to mark lead as HOT |
| `MAX_CONCURRENT_BROWSERS` | `3` | Playwright browser pool size |
| `LI_MAX_PROFILES_PER_SESSION` | `80` | Max LinkedIn profiles/session/day |
| `TALENT_ORIGIN_SERVICE_URL` | `http://localhost:5050` | Python origin classifier |
| `LOG_LEVEL` | `debug` (dev) / `info` (prod) | Pino log level |
| `LOG_PRETTY` | `true` (dev) / `false` (prod) | Human-readable logs |

---

## How to Resume After a Break

1. `cat .claude/CLAUDE.md` — see what's built vs what's missing
2. `cat .claude/KNOWLEDGE.md` — read this file for gotchas and decisions
3. `git log --oneline -10` — see recent commits
4. `ls src/**/*.ts` — see implemented files
5. Continue from first ❌ in the CLAUDE.md build tracker
