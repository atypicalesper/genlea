# Prompt: Implement Lead Scorer

You are implementing or modifying the lead scoring engine for GenLea. Context is in `.claude/CLAUDE.md` and the full rubric is in `LEAD_SCORING.md`.

## Task
Implement/update `src/scoring/scorer.ts` and `src/scoring/rules.ts`.

## Scoring Formula (0–100 total)
```
indian_ratio_score()     // 0–30 — see LEAD_SCORING.md §1
+ job_freshness_score()  // 0–20 — see LEAD_SCORING.md §2
+ tech_stack_score()     // 0–20 — see LEAD_SCORING.md §3
+ contact_score()        // 0–15 — see LEAD_SCORING.md §4
+ company_fit_score()    // 0–15 — see LEAD_SCORING.md §5
```

## Status Labels
```ts
type LeadStatus = 'hot_verified' | 'hot' | 'warm' | 'cold' | 'disqualified';
// 80–100 → hot_verified
// 65–79  → hot
// 50–64  → warm
// 35–49  → cold
// 0–34   → disqualified
```

## Requirements
- All rules in `rules.ts` as pure functions — no side effects
- `scorer.ts` orchestrates rules and returns `{ score: number, status: LeadStatus, breakdown: ScoreBreakdown }`
- `ScoreBreakdown` must show each component score for transparency
- Cap each component at its max — no overflows
- All inputs from normalized `Company` + `Contact[]` + `Job[]` types
