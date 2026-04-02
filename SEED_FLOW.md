# What happens when you run `npm run seed:100`

## TL;DR

`seed:100` pushes **2,400 discovery jobs** into Redis. The workers pick them up, scrape 8 sources, normalize + filter results, upsert companies into MongoDB, then cascade each company through enrichment → scoring automatically.

---

## Step 1 — The Script (`scripts/seed-queries.ts`)

`tsx scripts/seed-queries.ts 100` runs. The argument `100` is the **repeat count**.

The script has a hardcoded list of **24 seed queries** spread across 8 sources:

| Source       | Queries | Focus |
|---|---|---|
| Wellfound    | 8       | YC/seed/series-A startups, generative AI |
| LinkedIn     | 4       | YC, seed, series-A, 10–50 employees |
| Indeed       | 3       | Early-stage startups, YC |
| Crunchbase   | 2       | YC seed, series-A SaaS |
| Apollo       | 2       | Seed/series-A SaaS, 10–50 employees |
| Glassdoor    | 3       | Startup engineers, YC, backend |
| SurelyRemote | 4       | Remote startup roles, generative AI |
| ZoomInfo     | 0       | (none in current seed list) |

**Math:** `100 rounds × 24 queries = 2,400 total jobs`

For each round, a fresh `runId` is generated (UUID). Each job is pushed to the `discovery` BullMQ queue with:
- `runId` — groups all jobs from this seed run
- `source` — which scraper to use
- `query.keywords` — search string
- `query.location` — always `"United States"`
- `query.techStack` — e.g. `['nodejs', 'typescript']`
- `query.limit` — always `25` results per query

BullMQ retry config: 3 attempts, exponential backoff starting at 5s.

After enqueuing all 2,400 jobs, the script closes the queue connection and exits.

---

## Step 2 — Discovery Worker (`src/workers/discovery.worker.ts`)

Runs **N concurrent jobs** (configurable via the Worker Concurrency slider in the Control Panel, default 10). For each job:

### 2a. Availability check
Calls `scraper.isAvailable()` — checks if the required credentials/cookies exist. If not, the job is marked `skipped` in `scrape_logs` and dropped (no retry).

### 2b. Scrape
Calls `scraper.scrape(query)` → returns `RawResult[]`. Each raw result can contain:
- Company info (name, domain, employee count, funding, tech stack, country)
- Contacts (CEO, CTO, HR names/emails found on the page)
- Jobs (open roles with tech tags)

### 2c. Normalize + Deduplicate
- `normalizer.processResults()` — standardizes field names, lowercases domains, strips `www.`, strips trailing slashes. **Does not default country** — raw scraper value is passed through as-is.
- `deduplicateCompanies()` — within this batch, merges duplicate domains before writing to DB

### 2d. Filters (silent drops — nothing written to DB)
A company is silently skipped if any of these are true, checked in order:

1. **Missing `domain` or `name`**
2. **No tech signal** — no `techStack` and no jobs with tech tags
3. **Blocked domain** — 80+ hardcoded enterprise domains (Google, Stripe, JPMorgan, Deloitte, Walmart, etc.)
4. **Non-target country** — `hqCountry` is set AND is not in the allowed list (US, UK, CA, AU, EU countries, SG, IL, etc.). Companies without a country set pass through (majority — country defaults to 'US' on DB insert).
5. **Name pattern match** — company name matches a blocked pattern (bank, chase, morgan, insurance, hospital, deloitte, cognizant, government, federal, etc.)
6. **Too large** — `employeeCount > 1000`

### 2e. Upsert to MongoDB
`companyRepository.upsert()` — upserts by `domain` (unique key). New companies default to `hqCountry: 'US'` if not provided by the scraper.

### 2f. Save contacts + jobs
For each company, all contacts and jobs from the raw scraper output are saved in parallel via `Promise.allSettled`. Duplicates silently fail (unique index in MongoDB).

### 2g. Enqueue enrichment
Each successfully upserted company gets an `enrichment` job added:
```
sources: ['github', 'hunter', 'clearbit']
```

### 2h. Log
A `scrape_logs` document is written with `status: 'success'|'partial'|'failed'`, counts, errors, and duration.

---

## Step 3 — Enrichment Worker (`src/workers/enrichment.worker.ts`)

Runs **N concurrent jobs** (configurable via slider, default 15). For each company:

### Guard: size check
If `employeeCount > 1000` → immediately `disqualify()` the company and stop.

### Guard: cooldown
If the company was enriched within the last **7 days** → skip enrichment, go straight to scoring.
Override with `force=true` (set by the manual `/api/companies/:id/enrich` button in the dashboard).

### Step 1+2: GitHub + Clearbit (parallel)
Both run simultaneously:
- **GitHub** — finds the org by domain, extracts tech stack from repo languages + topics, pulls contributor names
- **Clearbit** — enriches company metadata (employee count, funding stage, industry)

Results are merged into the company document. GitHub contributor names are saved as contacts.

### Step 3: Website team page scraper
Playwright visits `/team`, `/about`, `/company` pages — extracts names + LinkedIn URLs. No API key.

### Step 3b: Defunct check
After the website scrape, the worker fetches the company's root URL and checks for:
- **DNS failure** (`ENOTFOUND`) — domain is dead
- **Connection refused** (`ECONNREFUSED`, `ECONNRESET`)
- **HTTP 404** on the root domain
- **Parked domain HTML** — "domain for sale", "account suspended", "buy this domain", etc.
- **Shutdown language** — "we are shutting down", "no longer in business", "company has closed", etc.

If any signal fires → `disqualify()` immediately and stop enrichment.

### Step 4: Hunter.io email discovery
Hunter's Domain Search API finds email addresses. Results normalized, deduped, saved with `emailConfidence` scores.

### Step 5: Contact Resolver
SMTP email verification + CEO/HR gap-fill using Hunter pattern + name guessing.

### Step 6: Dev Origin Ratio (the core signal)
Loads all contacts. Needs at least `minSample` names (configurable, default 5).

`devOriginAnalyzer.analyzeNames()` classifies each name as Indian-origin or not. Returns:
- `ratio` — fraction Indian-origin (0.0–1.0)
- `indianCount`, `totalCount`
- `reliable` — whether sample is large enough

Writes back to company. `toleranceIncluded = true` if ratio is between threshold and 0.75.

### Step 7: Enqueue scoring
Stamps `lastEnrichedAt`, then adds a `scoring` job.

---

## Step 4 — Scoring Worker (`src/workers/scoring.worker.ts`)

Runs **N concurrent jobs** (configurable via slider, default 30). For each company:

Fetches company + contacts + active jobs + settings simultaneously.

Runs `scoreCompany()` — 5 signals:

| Signal | Max | Based on |
|---|---|---|
| Indian origin ratio | 30 | `originRatio` vs threshold |
| Job freshness | 20 | How recently jobs were posted + count |
| Tech stack match | 20 | Overlap with target stacks (Node, Python, React, TS) |
| Contact quality | 15 | Has verified CEO/HR email? |
| Company fit | 15 | Employee count, funding stage, growth signals |

**Total: 0–100**

Score thresholds (configurable in Control Panel):
- `≥ 80` → `hot_verified` 🔥
- `65–79` → `hot` 🔥
- `50–64` → `warm` 🌡️
- `< 50` → `cold` ❄️

Syncs `openRoles[]` from active job titles, writes `score`, `status`, and `scoreBreakdown` to MongoDB.

---

## End State

After the full pipeline runs, each surviving company in MongoDB has:
- Normalized fields + `hqCountry` (US/UK/CA/etc.)
- Contacts with verified emails and origin flags
- Open roles list
- Indian dev ratio + sample size
- Score 0–100 + status + full breakdown

Available at `localhost:4000/dashboard` and `/api/leads`, `/api/companies`, `/api/export/csv`.

---

## Key Numbers for `seed:100`

| Metric | Value |
|---|---|
| Jobs pushed to Redis | 2,400 |
| Max results per scraper query | 25 |
| Discovery concurrency | 10 (default, slider-controlled) |
| Enrichment concurrency | 15 (default, slider-controlled) |
| Scoring concurrency | 30 (default, slider-controlled) |
| Enrichment cooldown (auto re-runs) | 7 days |
| Enrichment cooldown bypass | Manual trigger only (`force=true`) |
| BullMQ retries on failure | 3 (exponential backoff, 5s base) |

## Filters Summary (what gets dropped and where)

| Filter | Stage | Reason |
|---|---|---|
| Missing domain/name | Discovery | Can't dedup or identify |
| No tech signal | Discovery | Not a tech company |
| Blocked domain | Discovery | Known large enterprise |
| Non-target country | Discovery | HQ outside US/UK/CA/EU/AU/SG |
| Name pattern match | Discovery | Large bank/consulting/govt by name |
| Employee count > 1000 | Discovery + Enrichment | Too large, not a target |
| Recently enriched (< 7 days) | Enrichment | Skip re-enrichment, go to scoring |
| Defunct website | Enrichment | Dead domain, parked page, shutdown language |
