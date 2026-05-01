import type { Page } from 'playwright';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { logger } from './logger.js';
import type { FailureMode, ScrapeStageRecord, ScrapeDiagnosticsSummary } from '../types/index.js';

const DEBUG_DIR = process.env['SCRAPE_DEBUG_DIR'] ?? 'debug/scrapes';
const DUMP_ON_EMPTY = process.env['SCRAPE_DUMP_ON_EMPTY'] !== 'false';

/**
 * Wrap a Playwright scrape with timing, outcome classification, and
 * artifact dumps (HTML + screenshot + JSON) when things go wrong.
 */
export class ScrapeDiagnostics {
  private readonly startedAt = Date.now();
  private readonly stages: ScrapeStageRecord[] = [];
  private outcome: FailureMode = 'unknown';
  private itemsFound = 0;
  private artifactBase?: string;

  constructor(
    private readonly scraper: string,
    private readonly runId: string,
    private readonly url: string,
  ) {
    logger.info({ scraper, runId, url }, '[scrape-diag] started');
  }

  async stage<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      this.stages.push({ name, durationMs: Date.now() - t0, ok: true });
      logger.debug({ scraper: this.scraper, stage: name, ms: Date.now() - t0 }, '[scrape-diag] stage ok');
      return result;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.stages.push({ name, durationMs: Date.now() - t0, ok: false, detail });
      logger.warn({ scraper: this.scraper, stage: name, ms: Date.now() - t0, detail }, '[scrape-diag] stage failed');
      throw err;
    }
  }

  recordItems(n: number): void {
    this.itemsFound = n;
  }

  classify(signals: { captcha?: boolean; networkError?: boolean; timeout?: boolean; selectorMismatch?: boolean; pageText?: string }): FailureMode {
    // Classify from most explicit to least explicit so "empty" becomes a fallback, not a false root cause.
    if (signals.captcha)      return this.outcome = 'captcha';
    if (signals.timeout)      return this.outcome = 'timeout';
    if (signals.networkError) return this.outcome = 'network_error';
    if (signals.pageText && /access denied|you have been blocked|forbidden|unusual traffic/i.test(signals.pageText.slice(0, 3000))) {
      return this.outcome = 'blocked';
    }
    if (signals.selectorMismatch) return this.outcome = 'selector_mismatch';
    if (this.itemsFound === 0) return this.outcome = 'empty';
    return this.outcome = 'success';
  }

  async dump(page: Page, reason: string): Promise<string> {
    const ts   = new Date().toISOString().replace(/[:.]/g, '-');
    const dir  = join(DEBUG_DIR, this.scraper);
    const base = join(dir, `${this.runId}-${ts}`);

    try {
      await mkdir(dir, { recursive: true });
      const html = await page.content().catch(() => '');
      await writeFile(`${base}.html`, html);
      await page.screenshot({ path: `${base}.png`, fullPage: true }).catch(() => { /* viewport-only fallback already failed */ });
      this.artifactBase = base;
      logger.warn({ scraper: this.scraper, reason, artifactBase: base }, '[scrape-diag] artifacts dumped — inspect .html / .png to diagnose');
    } catch (err) {
      logger.warn({ scraper: this.scraper, err }, '[scrape-diag] failed to dump artifacts');
    }
    return base;
  }

  async finalize(page?: Page): Promise<ScrapeDiagnosticsSummary> {
    const summary: ScrapeDiagnosticsSummary = {
      scraper: this.scraper,
      runId: this.runId,
      url: this.url,
      outcome: this.outcome,
      totalMs: Date.now() - this.startedAt,
      itemsFound: this.itemsFound,
      stages: this.stages,
      artifactBase: this.artifactBase,
    };

    // Auto-dump the page only for failure-like outcomes so debug artifacts stay useful and bounded.
    const shouldDump = page && !this.artifactBase && (
      this.outcome === 'captcha' ||
      this.outcome === 'blocked' ||
      this.outcome === 'network_error' ||
      this.outcome === 'timeout' ||
      this.outcome === 'selector_mismatch' ||
      (this.outcome === 'empty' && DUMP_ON_EMPTY)
    );
    if (shouldDump && page) {
      await this.dump(page, `auto-dump:${this.outcome}`);
      summary.artifactBase = this.artifactBase;
    }

    if (summary.artifactBase) {
      await writeFile(`${summary.artifactBase}.json`, JSON.stringify(summary, null, 2)).catch(err =>
        logger.warn({ err, artifactBase: summary.artifactBase }, '[scrape-diagnostics] Failed to write summary JSON'),
      );
    }

    const level = this.outcome === 'success' ? 'info' : 'warn';
    logger[level](summary, `[scrape-diag] finished (${this.outcome})`);
    return summary;
  }
}
