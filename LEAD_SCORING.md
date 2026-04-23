# GenLea — Lead Scoring

---

## Status tiers

| Score | Status | Action |
|---|---|---|
| 80–100 | `hot_verified` | Immediate outreach — CEO + HR |
| 65–79 | `hot` | Personalised outreach |
| 50–64 | `warm` | Add to nurture sequence |
| 35–49 | `cold` | Low priority, enrich more later |
| < 35 | `disqualified` | Skip |

Thresholds are live-adjustable via `PATCH /api/settings`:
- `leadScoreHotVerifiedThreshold` (default 80)
- `leadScoreHotThreshold` (default 65)
- `leadScoreWarmThreshold` (default 50)
- `leadScoreColdThreshold` (default 35)

---

## Scoring formula

```
total_score =
  originRatio()    // 0–30 pts
  + jobFreshness() // 0–20 pts
  + techStack()    // 0–20 pts
  + contactScore() // 0–15 pts
  + companyFit()   // 0–15 pts
```

---

## 1. Origin ratio score (0–30 pts)

Rewards companies with a high % of Indian-origin developers.

```
if ratio >= 0.75: 30 pts
if ratio >= 0.50: 24 pts
if ratio >= 0.25: 16 pts
if ratio >= 0.10:  8 pts
if ratio >  0.00:  4 pts
unknown / no sample:       0 pts
```

`toleranceIncluded: true` is set when the ratio is below the ideal range but still above the configured threshold.

Minimum sample: `originRatioMinSample` (default 8 names). Below that, ratio is treated as unknown.

---

## 2. Job freshness score (0–20 pts)

Only active software/development/engineering roles count here. Generic open jobs do not score.

```
per active engineering job posting:
  posted ≤ 7 days:  +5 pts
  posted ≤ 30 days: +3 pts
  posted ≤ 90 days: +1 pt
  unknown posted date: +1 pt
cap: 20 pts
```

---

## 3. Tech stack score (0–20 pts)

Target tags: `nodejs, typescript, python, react, nextjs, nestjs, frontend, backend, fullstack, ai, ml, generative-ai, fastapi`

Configurable via `targetTechTags` in settings.

```
per matching tag in (company.techStack ∪ job.techTags): +3 pts
cap: 20 pts
```

---

## 4. Contact quality score (0–15 pts)

| Found | Points |
|---|---|
| CEO/Founder email (verified) | +7 |
| HR/Recruiter email (verified) | +7 |
| CEO LinkedIn URL | +1 |

Unverified email: half points. `emailConfidence < 0.60`: zero.

---

## 5. Company fit score (0–15 pts)

**Size:**
| Employee count | Points |
|---|---|
| 20–250 (sweet spot) | +6 |
| 10–19 or 251–500 | +3 |
| unknown, < 10, or > 500 | +0 |

**Funding stage:**
| Stage | Points |
|---|---|
| Pre-seed, Seed, Series A, Series B, Series C, Bootstrapped | +4 |
| Series D+ | +2 |

**Funding amount:**
| Total funding | Points |
|---|---|
| $1M–$250M | +3 |
| $250k–$1M | +1 |

**Company age:**
| Founded | Points |
|---|---|
| last 12 years | +2 |
| 13–18 years | +1 |

---

## Hard disqualification gates

Applied in the scoring worker regardless of numeric score:

- India-headquartered company (`hqCountry === 'IN'`)
- No engineering hiring signal from active jobs, hiring sources, or saved open roles
- No Indian-origin team signal after enrichment
- `employeeCount > 1000`
- `totalDevCount > 250`

Funding and founded year are fit signals, not hard gates. This avoids throwing away promising companies just because a free source did not return funding metadata.

---

## Re-scoring triggers

- New job posting found
- Existing job closed or expired
- Contact info enriched / verified
- Funding stage updated
- Manual: `POST /api/companies/:id/score`
- Bulk: `npm run rescore-all`
