import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact,
} from '../../types/index.js';
import { browserManager } from '../../core/browser.manager.js';
import { proxyManager } from '../../core/proxy.manager.js';
import { logger } from '../../utils/logger.js';
import { generateRunId } from '../../utils/random.js';
import { ScrapeDiagnostics } from '../../utils/scrape-diagnostics.js';

export class WellfoundScraper implements Scraper {
  name = 'wellfound' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const runId     = generateRunId();
    const browserId = `wellfound-${runId}`;
    const results: RawResult[] = [];
    const listingUrl = `https://wellfound.com/jobs?q=${encodeURIComponent(query.keywords)}&location=United+States`;
    const diag = new ScrapeDiagnostics('wellfound', runId, listingUrl);
    let page: Page | undefined;

    try {
      const proxy = proxyManager.getProxy();
      const context = await diag.stage('create_context', () => browserManager.createContext(browserId, { proxy }));
      page = await browserManager.newPage(context);

      // Wellfound gives better startup identity than generic job boards, but the listing page is selector-fragile.
      const companies = await this.scrapeHiringSection(page, query, diag);
      diag.recordItems(companies.length);

      for (const co of companies.slice(0, query.limit ?? 20)) {
        try {
          const result = await this.fetchCompanyDetail(page, co);
          if (result) results.push(result);
          await browserManager.humanDelay(1500, 3500);
        } catch (err) {
          logger.error({ err, company: co.name }, '[wellfound] Company detail failed — skipping');
        }
      }

      const pageText = await page.innerText('body').catch(() => '');
      const captcha  = await browserManager.detectCaptcha(page);
      diag.classify({ captcha, pageText });

      await context.close();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      diag.classify({ networkError: /timeout|ENOTFOUND|ECONNREFUSED|net::ERR/i.test(msg) });
      logger.error({ err }, '[wellfound] Fatal scrape error');
    } finally {
      await diag.finalize(page);
      await browserManager.closeBrowser(browserId);
    }

    return results;
  }

  // ── Hiring Section ──────────────────────────────────────────────────────────
  // Go directly to /jobs, then use DOM evaluation instead of brittle class names.

  private async scrapeHiringSection(
    page: Page,
    query: ScrapeQuery,
    diag: ScrapeDiagnostics,
  ): Promise<Array<{ name: string; slug: string; wellfoundUrl: string }>> {
    const q = encodeURIComponent(query.keywords);
    const url = `https://wellfound.com/jobs?q=${q}&location=United+States`;

    await diag.stage('navigate', async () => {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
      await browserManager.humanDelay(2000, 4000);
    });

    if (await browserManager.detectCaptcha(page)) {
      diag.classify({ captcha: true });
      await diag.dump(page, 'captcha_on_listing');
      return [];
    }

    await diag.stage('scroll', async () => {
      await browserManager.humanScroll(page, 6);
      await browserManager.humanDelay(1000, 2000);
    });

    // Company slugs are the most stable identifier on the listing page.
    const raw = await diag.stage('extract_slugs', () => page.evaluate((): Array<{ name: string; slug: string }> => {
      const seen = new Set<string>();
      const out: Array<{ name: string; slug: string }> = [];

      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]')).forEach(a => {
        const href = a.getAttribute('href') ?? '';
        const m = href.match(/\/company\/([^/?#]+)/);
        if (!m) return;
        const slug = m[1]!;
        if (seen.has(slug)) return;
        seen.add(slug);

        // Walk upward because the anchor text is often just an icon or nested fragment.
        let el: Element | null = a;
        for (let i = 0; i < 5; i++) {
          el = el?.parentElement ?? null;
          if (!el) break;
          const txt = el.textContent?.trim().split('\n')[0]?.trim() ?? '';
          if (txt.length > 2 && txt.length < 80) {
            out.push({ name: txt, slug });
            return;
          }
        }
        // Fallback: derive name from slug
        out.push({ name: slug.replace(/-/g, ' '), slug });
      });

      return out;
    }));

    if (raw.length === 0) {
      logger.warn({ url }, '[wellfound:hiring] Zero slugs extracted — selectors may be broken or page is empty');
    }

    return raw.map(({ name, slug }) => ({
      name,
      slug,
      wellfoundUrl: `https://wellfound.com/company/${slug}`,
    }));
  }

  // ── Company Detail Page ─────────────────────────────────────────────────────

  private async fetchCompanyDetail(
    page: Page,
    co: { name: string; slug: string; wellfoundUrl: string },
  ): Promise<RawResult | null> {
    logger.info({ company: co.name, url: co.wellfoundUrl }, '[wellfound:company] Scraping page');

    await page.goto(co.wellfoundUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await browserManager.humanDelay(1200, 2500);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn({ company: co.name }, '[wellfound:company] CAPTCHA detected');
      return null;
    }

    await browserManager.humanScroll(page, 3);

    // Detail pages are parsed via evaluate to survive class-name churn better than locators.
    const data = await page.evaluate((): {
      websiteUrl?: string; location?: string; empText?: string;
      stage?: string; description?: string;
      jobs: Array<{ title: string }>;
      founders: Array<{ fullName: string; roleText: string; linkedinUrl?: string }>;
    } => {
      // The company website is the best place to get a real domain for downstream enrichment.
      const websiteAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'))
        .find(a => !a.href.includes('wellfound.com') && !a.href.includes('linkedin.com') && !a.href.includes('twitter.com'));
      const websiteUrl = websiteAnchor?.href;

      // Location, employees, stage, description — try common label patterns
      const allText = Array.from(document.querySelectorAll('span, p, div'))
        .map(el => el.textContent?.trim() ?? '')
        .filter(t => t.length > 0 && t.length < 200);

      const location    = allText.find(t => /[A-Z][a-z]+(,\s*[A-Z]{2}|,\s*[A-Z][a-z]+)/.test(t) && t.length < 60) ?? '';
      const empText     = allText.find(t => /\d+[-–]\d+\s*(employees?)?|\d+\+\s*employees?/i.test(t)) ?? '';
      const stage       = allText.find(t => /seed|series [abc]|pre-seed|bootstrapped/i.test(t) && t.length < 40) ?? '';
      const description = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? '';

      // Jobs: any anchor with /jobs/ or job-title-ish text
      const jobs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/"]'))
        .slice(0, 15)
        .map(a => ({ title: a.textContent?.trim() ?? '' }))
        .filter(j => j.title.length > 3);

      // Founders / team: look for LinkedIn links with names nearby
      const founders: Array<{ fullName: string; roleText: string; linkedinUrl?: string }> = [];
      Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="linkedin.com/in/"]')).forEach(a => {
        const container = a.closest('div, li') ?? a.parentElement;
        const nameEl = container?.querySelector('h3, h4, strong, [class*="name"]');
        const roleEl = container?.querySelector('p, span');
        const fullName = nameEl?.textContent?.trim() ?? '';
        if (!fullName || fullName.length < 3) return;
        founders.push({
          fullName,
          roleText: roleEl?.textContent?.trim() ?? '',
          linkedinUrl: a.href,
        });
      });

      return { websiteUrl, location, empText, stage, description, jobs, founders };
    });

    let domain: string | undefined;
    if (data.websiteUrl) {
      try {
        domain = new URL(data.websiteUrl).hostname.replace(/^www\./, '');
      } catch { /* bad URL */ }
    }

    if (!domain) {
      // Missing domains are expected on some startup profiles; discovery can still keep the company by name.
      logger.debug({ slug: co.slug }, '[wellfound] No domain found — will filter downstream');
    }

    const locParts = (data.location ?? '').split(',').map(s => s.trim());
    const rawCompany: Partial<RawCompany> = {
      name:          co.name,
      domain,
      websiteUrl:    data.websiteUrl,
      description:   data.description || undefined,
      hqCity:        locParts[0],
      hqState:       locParts[1],
      hqCountry:     'US',
      employeeCount: parseEmployeeText(data.empText ?? ''),
      fundingStage:  mapStage(data.stage ?? ''),
    };

    const jobs = domain
      ? data.jobs.map(j => ({
          // Only attach jobs when they can be tied to a concrete company domain.
          companyDomain: domain!,
          title:         j.title,
          techTags:      extractTechFromTitle(j.title),
          source:        'wellfound' as const,
          sourceUrl:     `https://wellfound.com/company/${co.slug}/jobs`,
          postedAt:      undefined,
        }))
      : [];

    const contacts: Partial<RawContact>[] = data.founders.map(f => {
      const parts = f.fullName.split(' ');
      return {
        fullName:     f.fullName,
        firstName:    parts[0],
        lastName:     parts[parts.length - 1],
        role:         /ceo|founder|co-founder/i.test(f.roleText) ? 'Founder' as const : 'Unknown' as const,
        linkedinUrl:  f.linkedinUrl,
        companyDomain: domain,
      };
    });

    logger.info({ company: co.name, domain, jobs: jobs.length, contacts: contacts.length }, '[wellfound:company] Page scraped');

    return {
      source: 'wellfound',
      company: rawCompany,
      contacts,
      jobs,
      scrapedAt: new Date(),
    };
  }
}

function parseEmployeeText(text: string): number | undefined {
  // Convert ranges like "11-50" into a midpoint so size scoring can work on scraped text.
  const match = text.match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!match) return undefined;
  if (match[1] && match[2]) return Math.floor((parseInt(match[1], 10) + parseInt(match[2], 10)) / 2);
  if (match[3]) return parseInt(match[3], 10);
  return undefined;
}

function mapStage(stage?: string): import('../../types/index.js').FundingStage {
  if (!stage) return 'Unknown';
  const s = stage.toLowerCase();
  if (s.includes('series a')) return 'Series A';
  if (s.includes('series b')) return 'Series B';
  if (s.includes('series c')) return 'Series C';
  if (s.includes('seed')) return 'Seed';
  if (s.includes('pre-seed') || s.includes('pre seed')) return 'Pre-seed';
  if (s.includes('bootstrapped') || s.includes('profitable')) return 'Bootstrapped';
  return 'Unknown';
}

function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'], [/react/i, 'react'],
    [/next\.?js/i, 'nextjs'], [/nest\.?js/i, 'nestjs'],
    [/python/i, 'python'], [/typescript/i, 'typescript'],
    [/javascript/i, 'javascript'],
    [/frontend|front.end/i, 'frontend'], [/backend|back.end/i, 'backend'],
    [/fullstack|full.stack/i, 'fullstack'], [/machine learning|ml/i, 'ml'],
    [/ai engineer|generative/i, 'generative-ai'], [/fastapi|django|flask/i, 'python'],
    [/graphql/i, 'graphql'], [/golang|go\b/i, 'golang'],
    [/ruby|rails/i, 'ruby'], [/rust\b/i, 'rust'],
    [/java\b/i, 'java'], [/swift|ios/i, 'ios'], [/android|kotlin/i, 'android'],
    [/devops|sre|platform/i, 'devops'], [/cloud|aws|gcp|azure/i, 'cloud'],
    [/mobile/i, 'mobile'], [/data engineer|analytics engineer/i, 'data-engineering'],
    [/software engineer|software developer|swe\b/i, 'software'],
    [/staff engineer|principal engineer|senior engineer/i, 'software'],
  ];
  const tags = [...new Set(patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag))];
  return tags.length ? tags : ['software'];
}

export const wellfoundScraper = new WellfoundScraper();
