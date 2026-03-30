# GenLea — Scraping Notes (Per Source)

> Reference: how each source works, what data it provides, gotchas, and anti-detection tips.

---

## LinkedIn

### What We Get
- Company page: name, HQ, size range, about, website
- Employee list: names, titles, location (used for ratio analysis)
- Job postings: title, description, tech tags, posted date
- People search: CEOs, CTOs, HR contacts

### Playwright Flow
```
1. Open browser (stealth mode, residential proxy)
2. Load session cookies from sessions/linkedin/{account}.json
3. Navigate to: linkedin.com/search/results/companies/?keywords={query}&filters=...
4. Scroll slowly, extract company cards
5. For each company → visit company page
6. Click 'People' tab → scroll → extract employee names
7. Click 'Jobs' tab → collect active postings
8. People search: "{company name} HR" → collect HR contacts
9. Save cookies back to session file
```

### Anti-Detection Rules
- Max 80–100 profile views per session per day
- Delay: 3–8s between page navigations (randomized)
- Scroll slowly (not instant jump) — simulate human reading
- Never open > 5 tabs in parallel
- Use warm accounts (30+ days old, 50+ connections)
- If CAPTCHA detected → pause session 12h, switch account

### URL Patterns
```
Company Search:  /search/results/companies/?keywords=QUERY&origin=FACETED_SEARCH
Company Page:    /company/SLUG/
People:          /company/SLUG/people/
Jobs:            /company/SLUG/jobs/
People Search:   /search/results/people/?keywords=HR+{company}&currentCompany=[ID]
```

### Selectors (may drift — check regularly)
```ts
// Company card
'.entity-result__item'
'.entity-result__title-text a'

// Employee name on people tab
'.artdeco-entity-lockup__title'
'.artdeco-entity-lockup__subtitle'

// Job card
'.job-card-container__link'
'.job-card-container__company-name'
```

---

## Sales Navigator

### What We Get
- Filtered lead lists (geographic + company size + seniority filters)
- Org charts — who reports to whom
- Contact intent signals ("recently viewed your profile")
- Direct email + phone (paid tier)

### Flow
```
1. Login via session cookies (Sales Nav needs paid account)
2. Navigate to Lead Filters:
   - Geography: United States
   - Seniority: C-Suite, VP, Director (for CEO/HR)
   - Function: Engineering, Human Resources
   - Company Headcount: 11–500
3. Scrape lead list (scroll pagination)
4. For each lead → save name, title, company, LinkedIn URL
```

### Notes
- Sales Navigator has much more relaxed rate limits than regular LinkedIn
- Export limit: ~1000 leads visible per search
- Use `&savedSearch=true` to avoid re-querying

---

## Crunchbase

### API Endpoints (v4 — requires API key)
```
POST /searches/organizations
  body: { field_ids: [...], query: [...], limit: 25 }

GET /entities/organizations/{permalink}
  query: { field_ids: "short_description,num_employees_enum,funding_total,..." }
```

### Playwright Fallback
- For data not in API (key people, tech stack): scrape company profile page
- `crunchbase.com/organization/SLUG`
- Key People section: CEO, CTO, Founder names + LinkedIn links

### What We Get
| Field | Source |
|---|---|
| Company name, domain | API |
| HQ location | API |
| Employee count range | API |
| Funding stage + total | API |
| Founded year | API |
| CEO/Founder name | API + page |
| Tech stack (categories) | Page |
| LinkedIn URL | Page |

---

## ZoomInfo

### Flow (Playwright Stealth)
```
1. Login (session cookies)
2. Company search with filters: US, tech industry, size 10–500
3. Extract company profile: email domain, phone, HQ
4. Click "Contacts" → filter by "HR", "Recruiter", "CEO"
5. Extract: name, title, email, direct dial
```

### Gotchas
- ZoomInfo has aggressive bot detection — use fresh residential proxies
- Rate limit: 5 companies/min max
- "Intent data" fields need premium plan
- Always verify emails from ZoomInfo (their data has ~15% stale rate)

---

## Apollo.io

### Free API (25 email reveals/month — use carefully)
```
# Company search
POST /v1/mixed_companies/search
{
  "q_organization_domains": ["acme.com"],
  "num_employees_ranges": ["11,200"]
}

# People search (with company)
POST /v1/mixed_people/search
{
  "q_organization_name": "Acme Corp",
  "person_titles": ["CEO", "HR", "Recruiter", "Head of Talent"]
}

# Email reveal (costs credits)
POST /v1/people/match
{ "first_name": "John", "last_name": "Doe", "organization_name": "Acme" }
```

### Notes
- Apollo has the best coverage for startup HR contacts
- Combine with Hunter.io pattern for high-confidence email
- Free tier: 50 exports/month — use only for verified hot leads

---

## Hunter.io

### API Usage
```
# Find company email pattern
GET /v2/domain-search?domain=acme.com&api_key=KEY

# Verify specific email
GET /v2/email-verifier?email=john@acme.com&api_key=KEY

# Find person email
GET /v2/email-finder?domain=acme.com&first_name=John&last_name=Doe&api_key=KEY
```

### Notes
- Best for confirming email format pattern (`{first}.{last}@domain.com`)
- Once pattern known → generate emails without spending credits
- Confidence score < 70% → skip

---

## GitHub

### API Usage (for tech stack validation)
```
# Get org repos
GET /orgs/{org}/repos?sort=updated&per_page=50

# Get repo language breakdown
GET /repos/{owner}/{repo}/languages

# Check for specific tech presence
GET /search/code?q=import+nestjs+org:{org}
```

### What We Get
- Confirmed tech stack (languages used in actual code)
- Number of developers contributing
- Commit activity (is company actively coding?)
- Indian developer names from contributor list

### Notes
- Always search GitHub org name matching company domain
- Use authenticated requests (5000 req/hour vs 60 unauthenticated)

---

## Clearbit

### API Usage
```
# Company enrichment from domain
GET /v2/companies/find?domain=acme.com
  → returns: name, category, tech, location, metrics.employees, foundedYear

# Person enrichment
GET /v2/people/find?email=john@acme.com
  → returns: name, role, location, linkedin, bio
```

### Notes
- Excellent for enriching any company where we have domain
- 20 free requests/month — use sparingly as a final enrichment step
- Tech stack field (`tech`) is goldmine: lists actual tools used

---

## Glassdoor / Indeed / Wellfound

### Wellfound (AngelList Talent)
- Good for startups with specific tech requirements
- Playwright: search → filter by "Backend", "React", "ML" roles → extract company + job
- URL: `wellfound.com/jobs?role=Backend+Engineer&location=United+States`

### Indeed
- Search: `site:indeed.com "nodejs" OR "react" OR "python" "US" developer`
- Extract job → company name → cross-reference with other sources

### Glassdoor
- Employee count by nationality hints from review text (manual signal)
- Use carefully — heavily rate-limited

---

## Cross-Reference Strategy (Boosting Lead Quality)

A lead confirmed across multiple sources = higher score:

| Sources Matched | Confidence Tier |
|---|---|
| 1 source | Low (skip unless unique info) |
| 2 sources | Medium (warm lead) |
| 3+ sources | High (hot lead candidate) |

### Merge Logic
1. `domain` is canonical unique key — if two scrapers return same domain → merge
2. Prefer most-recent data when fields conflict
3. Sum up confirmed contacts across sources (Apollo email + Hunter pattern = very high confidence)
