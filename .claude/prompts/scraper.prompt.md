# Prompt: Build a New Scraper

You are building a new scraper for GenLea. The project context is in `.claude/CLAUDE.md`.

## Task
Build a scraper for **{SOURCE_NAME}** in `src/scrapers/{source}.scraper.ts`.

## Requirements
1. Implement the `Scraper` interface from `src/types/scraper.types.ts`
2. Use `BrowserManager` from `src/core/browser.manager.ts` for Playwright instances
3. Use `ProxyManager` from `src/core/proxy.manager.ts` for proxy rotation
4. Add structured Pino logging with `scraper`, `run_id`, and `company_domain` fields
5. Handle rate limiting: randomized delays between `SCRAPE_DELAY_MIN_MS` and `SCRAPE_DELAY_MAX_MS`
6. Return `RawResult[]` — never write to MongoDB directly (that's the normalizer's job)
7. Handle errors gracefully — catch per-company errors, continue processing
8. Implement `isAvailable()` to check if credentials/session is valid

## Interface to implement
```ts
interface Scraper {
  name: string;
  scrape(query: ScrapeQuery): Promise<RawResult[]>;
  isAvailable(): Promise<boolean>;
}
```

## Output shape (RawResult)
```ts
{
  source: string;
  company?: Partial<RawCompany>;
  contacts?: Partial<RawContact>[];
  jobs?: Partial<RawJob>[];
  scrapedAt: Date;
}
```

## Anti-Detection Checklist
- [ ] Randomized delays between every navigation
- [ ] Slow scroll simulation (not instant jump)
- [ ] Randomized viewport from BrowserManager
- [ ] Proxy from ProxyManager
- [ ] Session cookies loaded from SessionManager (if applicable)
- [ ] CAPTCHA detection → log warning + return partial results
