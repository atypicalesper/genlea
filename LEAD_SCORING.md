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
if ratio >= 0.90: 30 pts
if ratio >= 0.75: 25 pts
if ratio >= 0.60: 17 pts   ← tolerance floor
if ratio <  0.50:  0 pts
unknown (no sample):       10 pts  ← neutral, not zero
```

`toleranceIncluded: true` is set on companies at 60–74% ratio.

Minimum sample: `originRatioMinSample` (default 8 names). Below that, ratio is treated as unknown → 10 pts.

---

## 2. Job freshness score (0–20 pts)

```
per active job posting:
  posted ≤ 7 days:  +5 pts
  posted ≤ 30 days: +3 pts
  posted ≤ 90 days: +1 pt
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
| 30–200 (sweet spot) | +7 |
| 11–29 or 201–500 | +4 |
| < 11 or > 500 | +0 |

**Funding stage:**
| Stage | Points |
|---|---|
| Series A or B | +5 |
| Series C | +3 |
| Bootstrapped | +2 |
| Seed | +1 |

**Industry bonus (max +3, configurable via `highValueIndustries`):**
| Industry | Points |
|---|---|
| ai, saas, fintech, healthtech | +3 |
| edtech | +2 |

---

## Hard disqualification gates

Applied in the scoring worker regardless of numeric score:

- India-headquartered company (`hqCountry === 'IN'`)
- No verified funding (missing or unknown stage)
- No active engineering hiring signal
- No Indian-origin team signal (`indianDevRatio` undetectable after enrichment)
- `employeeCount > 1000`

---

## Re-scoring triggers

- New job posting found
- Existing job closed or expired
- Contact info enriched / verified
- Funding stage updated
- Manual: `POST /api/companies/:id/score`
- Bulk: `npm run rescore-all`
