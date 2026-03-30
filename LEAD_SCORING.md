# GenLea — Lead Scoring Rubric

> Full specification of how companies and contacts are scored 0–100.
> Leads ≥65 = HOT 🔥 | 50–64 = WARM 🌡️ | <50 = COLD ❄️

---

## Scoring Formula

```
total_score = 
  indian_ratio_score()     // 0–30 pts
  + job_freshness_score()  // 0–20 pts
  + tech_stack_score()     // 0–20 pts
  + contact_score()        // 0–15 pts
  + company_fit_score()    // 0–15 pts
```

---

## 1. Indian Ratio Score (0–30 pts)

Goal: reward companies with a high % of Indian-origin developers.

```
ratio = indian_dev_count / total_dev_count

if ratio >= 0.90: score = 30
if ratio >= 0.75: score = 25
if ratio >= 0.60: score = 17    ← tolerance floor (includes in funnel)
if ratio >= 0.50: score = 10
if ratio <  0.50: score = 0     ← excluded from hot/warm
```

**Tolerance Mode** (enabled via `INDIAN_RATIO_THRESHOLD=0.60`):
- Companies at 60–74% ratio are still included, scored 17/30
- Useful for widening dataset
- Flagged with `tolerance_included: true` on company doc

**How ratio is calculated:**
1. Collect all employee first+last names from LinkedIn "People" tab (filter: Engineering titles)
2. Pass names through `ethnicolr` or `name-nationality` package
3. Count those predicted `south_asian` / `indian` with confidence ≥0.70
4. `ratio = indian_count / total_engineers_visible`
5. Min 10 employees needed to compute reliable ratio

---

## 2. Job Freshness Score (0–20 pts)

Goal: companies actively hiring right now are more targetable.

```
for each open job posting:
  if posted_within == 7 days:  +5 pts
  if posted_within == 30 days: +3 pts
  if posted_within == 90 days: +1 pt

cap at 20 pts
```

Additional: +2 pts bonus if job description mentions "urgently hiring" or "immediate".

**Where jobs come from:** LinkedIn Jobs tab, Wellfound, Indeed, company careers page.

---

## 3. Tech Stack Score (0–20 pts)

Goal: company's actual + hiring tech stack must overlap with our service offering.

**Target tags:**
```
nodejs, typescript, python, react, nextjs, nestjs,
frontend, backend, fullstack, ai, ml, generative-ai,
fastapi, django, expressjs, graphql
```

```
for each matching tag in (company.tech_stack + job.tech_tags):
  score += 3
cap at 20 pts
```

Bonus: +3 if "ai" or "ml" or "generative-ai" present (these are highest-value prospects).

**Sources for tech stack:**
- Clearbit `tech` field (actual tools they use)
- GitHub language analysis
- Job postings tech keywords
- Crunchbase category tags

---

## 4. Contact Completeness Score (0–15 pts)

Goal: the more complete the contact info, the more actionable the lead.

| Contact Found | Points |
|---|---|
| CEO email (verified) | +5 |
| HR/Recruiter email (verified) | +5 |
| Direct phone for CEO or HR | +3 |
| CEO LinkedIn URL | +1 |
| HR LinkedIn URL | +1 |

```
max = 15 pts
```

If `email_verified == false` → count half points for that email.
If `email_confidence < 0.70` → don't count.

---

## 5. Company Fit Score (0–15 pts)

Goal: company profile matches our ideal client.

### Size
| Employee Count | Points |
|---|---|
| 30–200 (sweet spot) | +7 |
| 11–29 or 201–500 | +4 |
| < 11 or > 500 | +0 |

### Funding Stage
| Stage | Points |
|---|---|
| Series A | +5 |
| Series B | +5 |
| Series C | +4 |
| Bootstrapped (profitable signals) | +3 |
| Seed | +2 |
| Pre-seed | +1 |
| Public / PE / Unknown | +0 |

### Industry Bonus (max +3)
| Industry | Points |
|---|---|
| AI/ML | +3 |
| SaaS | +2 |
| Fintech | +2 |
| HealthTech | +2 |
| EdTech | +1 |

---

## Status Labels

| Score | Status | Action |
|---|---|---|
| 80–100 | `hot_verified` | Immediately outreach CEO + HR |
| 65–79 | `hot` | Outreach with personalized template |
| 50–64 | `warm` | Add to nurture sequence |
| 35–49 | `cold` | Low priority, enrich more later |
| 0–34 | `disqualified` | Skip |

---

## Re-Scoring Triggers

A company is re-scored when:
1. New job posting found (score may increase)
2. Old job closed (score may decrease)
3. Funding event detected (score increases)
4. Contact info enriched (score increases)
5. Manual trigger via API `POST /companies/{id}/rescore`

---

## Deduplication Rules

Canonical key = `domain` (e.g., `acme.com`)
- Strip `www.`, trailing slashes, normalize to lowercase
- If two scrapers return same domain → merge records
- On merge: take max of any numeric field, union of array fields

---

## Confidence Tags

Extra metadata attached to each lead:

```ts
{
  "sources_count": 3,           // how many sources confirmed this company
  "email_verified_count": 2,    // verified emails available
  "last_job_posted_days": 4,    // days since last job post
  "tolerance_included": false,  // included via relaxed ratio threshold
  "manually_reviewed": false    // flagged for manual QA
}
```
