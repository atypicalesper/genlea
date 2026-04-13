import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawJob,
} from '@genlea/shared';
import { browserManager } from '@genlea/shared';
import { proxyManager } from '@genlea/shared';
import { logger } from '@genlea/shared';
import { generateRunId } from '@genlea/shared';

/**
 * Surely Remote (surelyremote.com) scraper.
 * COMPLETELY FREE — no API key, no login required.
 * Curated remote-first job listings — great for identifying US startups
 * that are actively hiring distributed teams (prime outsourcing targets).
 */
export class SurelyRemoteScraper implements Scraper {
  name = 'surelyremote' as const;

  async isAvailable(): Promise<boolean> {
    return true; // no auth required
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `surelyremote-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords, limit: query.limit }, '[surelyremote] Starting scrape');

    try {
      const proxy = proxyManager.getProxy();
      const contextOpts = proxy ? { proxy } : {};
      const context = await browserManager.createContext(browserId, contextOpts);
      const page = await browserManager.newPage(context);

      const jobGroups = await this.scrapeJobs(page, query);
      logger.info({ companies: jobGroups.size }, '[surelyremote] Unique companies found');

      for (const [companyName, { jobs, domain, websiteUrl }] of jobGroups) {
        const rawCompany: Partial<RawCompany> = {
          name:      companyName,
          domain:    domain ?? slugifyName(companyName),
          websiteUrl,
          hqCountry: 'US',
        };

        results.push({
          source: 'surelyremote',
          company: rawCompany,
          jobs,
          scrapedAt: new Date(),
        });
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[surelyremote] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[surelyremote] Scrape complete');
    return results;
  }

  private async scrapeJobs(
    page: Page,
    query: ScrapeQuery,
  ): Promise<Map<string, { jobs: RawJob[]; domain?: string; websiteUrl?: string }>> {
    const jobGroups = new Map<string, { jobs: RawJob[]; domain?: string; websiteUrl?: string }>();
    const limit = query.limit ?? 50;

    // Build search URL — Surely Remote supports keyword search
    const keywords = (query.techStack ?? []).join(' ') || query.keywords;
    const encoded  = encodeURIComponent(keywords);
    const url      = `https://surelyremote.com/jobs?search=${encoded}`;

    logger.debug({ url }, '[surelyremote:search] Navigating');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(2000, 4000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[surelyremote:search] CAPTCHA detected — aborting');
      return jobGroups;
    }

    await browserManager.humanScroll(page, 4);

    // Paginate up to 4 pages
    for (let p = 0; p < 4; p++) {
      const cards = await page.$$(
        'article, [class*="job-card"], [class*="jobCard"], [class*="job_card"], .job-listing, li[class*="job"]'
      );

      logger.debug({ page: p + 1, cards: cards.length }, '[surelyremote:search] Job cards');

      for (const card of cards) {
        if ([...jobGroups.values()].flatMap(v => v.jobs).length >= limit) break;

        try {
          const titleEl   = await card.$('h2, h3, [class*="title"], [class*="position"]');
          const companyEl = await card.$('[class*="company"], [class*="employer"], [class*="org"]');
          const dateEl    = await card.$('time, [class*="date"], [class*="posted"]');
          const linkEl    = await card.$('a[href]');
          const tagEls    = await card.$$('[class*="tag"], [class*="tech"], [class*="skill"], [class*="badge"]');

          const title       = (await titleEl?.textContent())?.trim();
          const companyName = (await companyEl?.textContent())?.trim();
          if (!title || !companyName) continue;

          const dateText  = (await dateEl?.getAttribute('datetime')) ?? (await dateEl?.textContent())?.trim() ?? '';
          const sourceUrl = await linkEl?.getAttribute('href') ?? undefined;
          const tagTexts  = await Promise.all(tagEls.map(t => t.textContent()));
          const techFromTags = tagTexts
            .map(t => t?.trim().toLowerCase() ?? '')
            .filter(t => TECH_TAGS.has(t))
            .map(t => TECH_TAGS.get(t)!);

          const techFromTitle = extractTechFromTitle(title);
          const techTags = [...new Set([...techFromTitle, ...techFromTags])];
          const postedAt = parseDateAttr(dateText) ?? parseRelativeDate(dateText);

          // Try to pick up a company website from a link inside the card
          const websiteEl  = await card.$('a[href^="http"]:not([href*="surelyremote"])');
          const websiteRaw = await websiteEl?.getAttribute('href') ?? undefined;
          let domain: string | undefined;
          let websiteUrl: string | undefined;
          if (websiteRaw) {
            try {
              const u = new URL(websiteRaw);
              domain     = u.hostname.replace(/^www\./, '');
              websiteUrl = websiteRaw;
            } catch { /* ignore bad URLs */ }
          }

          const job: RawJob = {
            companyDomain: domain ?? slugifyName(companyName),
            title,
            techTags,
            source:    'surelyremote',
            sourceUrl: sourceUrl
              ? (sourceUrl.startsWith('http') ? sourceUrl : `https://surelyremote.com${sourceUrl}`)
              : undefined,
            postedAt,
          };

          if (!jobGroups.has(companyName)) {
            jobGroups.set(companyName, { jobs: [], domain, websiteUrl });
          }
          jobGroups.get(companyName)!.jobs.push(job);

        } catch (err) {
          logger.debug({ err }, '[surelyremote:search] Card parse error');
        }
      }

      if ([...jobGroups.values()].flatMap(v => v.jobs).length >= limit) break;

      // Next page
      const nextBtn = await page.$('[aria-label="Next"], [rel="next"], a[href*="page="]:last-of-type, button:has-text("Next")');
      if (!nextBtn) break;

      logger.debug({ page: p + 2 }, '[surelyremote:search] Next page');
      await nextBtn.click();
      await browserManager.humanDelay(2500, 4500);
      await browserManager.humanScroll(page, 3);
    }

    return jobGroups;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugifyName(name: string): string {
  return name.toLowerCase()
    .replace(/\s+(inc|llc|ltd|corp|co\.?)\.?$/i, '')
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 40) + '.com';
}

/** Parse ISO / datetime attr */
function parseDateAttr(text: string): Date | undefined {
  if (!text) return undefined;
  const d = new Date(text);
  return isNaN(d.getTime()) ? undefined : d;
}

/** Parse relative strings like "3 days ago", "2 weeks ago" */
function parseRelativeDate(text: string): Date | undefined {
  const now = Date.now();
  const m = text.match(/(\d+)\s*(hour|day|week|month)/i);
  if (!m) return undefined;
  const n    = parseInt(m[1]!);
  const unit = m[2]!.toLowerCase();
  const ms   = unit.startsWith('hour')  ? n * 3_600_000
             : unit.startsWith('day')   ? n * 86_400_000
             : unit.startsWith('week')  ? n * 7 * 86_400_000
             : n * 30 * 86_400_000;
  return new Date(now - ms);
}

function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'],    [/react(?!.?native)/i, 'react'],
    [/react native/i, 'react-native'],  [/next\.?js/i, 'nextjs'],
    [/nest\.?js/i, 'nestjs'],           [/python/i, 'python'],
    [/typescript/i, 'typescript'],      [/frontend|front.end/i, 'frontend'],
    [/backend|back.end/i, 'backend'],   [/fullstack|full.stack/i, 'fullstack'],
    [/machine learning|ml engineer/i, 'ml'],
    [/ai engineer|generative ai|llm/i, 'generative-ai'],
    [/fastapi|django|flask/i, 'python'], [/graphql/i, 'graphql'],
    [/golang|go\b/i, 'golang'],         [/java\b/i, 'java'],
    [/swift|ios/i, 'ios'],              [/android|kotlin/i, 'android'],
    [/devops|sre|platform engineer/i, 'devops'],
    [/data engineer|spark|airflow/i, 'data-engineering'],
    [/rust\b/i, 'rust'],                [/elixir/i, 'elixir'],
  ];
  return [...new Set(
    patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag)
  )];
}

/** Map common tag label → canonical tech tag */
const TECH_TAGS = new Map<string, string>([
  ['node', 'nodejs'], ['node.js', 'nodejs'], ['nodejs', 'nodejs'],
  ['react', 'react'], ['nextjs', 'nextjs'], ['next.js', 'nextjs'],
  ['typescript', 'typescript'], ['python', 'python'],
  ['go', 'golang'], ['golang', 'golang'], ['rust', 'rust'],
  ['java', 'java'], ['kotlin', 'kotlin'], ['swift', 'ios'],
  ['ai', 'ai'], ['ml', 'ml'], ['llm', 'generative-ai'],
  ['graphql', 'graphql'], ['fastapi', 'python'], ['django', 'python'],
  ['fullstack', 'fullstack'], ['frontend', 'frontend'], ['backend', 'backend'],
]);

export const surelyRemoteScraper = new SurelyRemoteScraper();
