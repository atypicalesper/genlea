# GenLea 🎯

> Automated B2B Lead Generation Engine — Finds US tech companies with high Indian developer ratios that are actively hiring and extracts CEO, CTO, and HR contact information.

---

## What It Does

1. **Discovers** US tech companies via LinkedIn, Crunchbase, Apollo, Wellfound, and more
2. **Filters** for companies with ≥60% Indian-origin developers (≥75% strict mode)
3. **Verifies** active hiring in Node.js / Python / React / AI / NestJS / Next.js stack
4. **Extracts** CEO, CTO, and HR contact info (email, phone, LinkedIn)
5. **Scores** each lead 0–100 based on fit, freshness, and contact completeness
6. **Exports** hot leads (≥65) as CSV or via REST API

---

## Quick Start

### Prerequisites
- Node.js 20+
- MongoDB (local or Atlas)
- Redis
- Residential proxy subscription (BrightData / Oxylabs recommended)
- LinkedIn account(s) for session scraping

### Setup

```bash
# 1. Clone into genlea/
cd genlea

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your credentials

# 4. Start infrastructure (MongoDB + Redis)
docker-compose up -d

# 5. Initialize DB (indexes + seed collections)
npm run db:init

# 6. Start everything
npm run dev
```

---

## Architecture

See [`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full system design.

```
Discovery → Enrichment → Scoring → MongoDB → API/Export
```

Each phase is a BullMQ worker. All Playwright scraping uses stealth mode + rotating residential proxies.

---

## Data Sources

| Source | Purpose | Method |
|---|---|---|
| LinkedIn | Employees, jobs, contacts | Playwright stealth |
| Sales Navigator | Filtered lead lists | Playwright stealth |
| Crunchbase | Founders, funding | API + Playwright |
| ZoomInfo | Direct contacts | Playwright stealth |
| Apollo.io | Email discovery | API |
| Hunter.io | Email pattern | API |
| GitHub | Tech stack proof | REST API |
| Clearbit | Company enrichment | API |
| Wellfound | Startup job posts | Playwright |

---

## Lead Scoring

| Score | Status | Action |
|---|---|---|
| 80–100 | 🔥 hot_verified | Immediate outreach |
| 65–79 | 🔥 hot | Personalized outreach |
| 50–64 | 🌡️ warm | Nurture sequence |
| < 50 | ❄️ cold | Skip |

See [`LEAD_SCORING.md`](./LEAD_SCORING.md) for the full scoring rubric.

---

## API

```bash
# Get hot leads
GET http://localhost:4000/leads?status=hot

# Get a company's contacts
GET http://localhost:4000/companies/:id/contacts

# Export CSV
GET http://localhost:4000/export/csv?status=hot

# Queue status
GET http://localhost:4000/jobs/status

# Manually trigger scrape
POST http://localhost:4000/scrape
{ "source": "linkedin", "query": "software startup US nodejs" }
```

---

## CLI Commands

```bash
npm run workers         # Start BullMQ workers
npm run api             # Start Fastify API
npm run scrape          # Trigger manual scrape
npm run score           # Re-score all companies
npm run export          # Export hot leads → exports/leads.csv
npm run db:init         # Initialize MongoDB indexes
npm run db:stats        # Print collection stats
```

---

## Directory Structure

```
genlea/
├── .claude/            # Claude AI context
├── src/
│   ├── scrapers/       # One module per data source
│   ├── core/           # Browser, queue, proxy, session
│   ├── enrichment/     # Normalize, dedup, ratio, email
│   ├── scoring/        # Rule-based 0–100 scorer
│   ├── workers/        # BullMQ workers per phase
│   ├── storage/        # MongoDB repositories
│   └── api/            # Fastify REST API
├── sessions/           # LinkedIn session cookies (gitignored)
├── proxies/            # Proxy lists (gitignored)
├── exports/            # CSV output (gitignored)
├── ARCHITECTURE.md
├── SCRAPING_NOTES.md
├── LEAD_SCORING.md
└── .env.example
```

---

## Important Notes

- **LinkedIn anti-scraping**: Max 80 profiles/session/day. Sessions rotate automatically.
- **Proxy**: Residential proxies required for LinkedIn/ZoomInfo. Datacenter IPs get blocked.
- **Ethics**: This tool is for sales outreach. Respect platform ToS for production use.
- **Data freshness**: Cron jobs re-scrape nightly. Job posts older than 90 days are marked inactive.

---

## Contributing

1. Each new scraper must implement the `Scraper` interface in `src/scrapers/`
2. All env vars must be added to `.env.example`
3. Dedup by domain — always go through `deduplicator.ts`
4. Score every company before writing to MongoDB
