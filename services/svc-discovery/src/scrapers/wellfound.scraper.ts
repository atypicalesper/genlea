import { Page } from 'playwright';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany, RawContact, FundingStage, RawJob,
} from '@genlea/shared';
import { browserManager, proxyManager, logger, generateRunId } from '@genlea/shared';

export class WellfoundScraper implements Scraper {
  name = 'wellfound' as const;

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async scrape(query: ScrapeQuery): Promise<RawResult[]> {
    const browserId = `wellfound-${generateRunId()}`;
    const results: RawResult[] = [];

    logger.info({ keywords: query.keywords, limit: query.limit }, '[wellfound] Starting scrape');

    try {
      const proxy = proxyManager.getProxy();
      const context = await browserManager.createContext(browserId, { proxy });
      const page = await browserManager.newPage(context);

      const companies = await this.scrapeHiringSection(page, query);
      logger.info({ found: companies.length }, '[wellfound] Companies found');

      for (const co of companies.slice(0, query.limit ?? 20)) {
        try {
          const result = await this.fetchCompanyDetail(page, co);
          if (result) results.push(result);
          await browserManager.humanDelay(1500, 3500);
        } catch (err) {
          logger.error({ err, company: co.name }, '[wellfound] Company detail failed — skipping');
        }
      }

      await context.close();
    } catch (err) {
      logger.error({ err }, '[wellfound] Fatal scrape error');
    } finally {
      await browserManager.closeBrowser(browserId);
    }

    logger.info({ results: results.length }, '[wellfound] Scrape complete');
    return results;
  }

  // ── Hiring Section ──────────────────────────────────────────────────────────

  private async scrapeHiringSection(
    page: Page,
    query: ScrapeQuery,
  ): Promise<Array<{ name: string; slug: string; wellfoundUrl: string }>> {
    const q = encodeURIComponent(query.keywords);
    const url = `https://wellfound.com/jobs?q=${q}&location=United+States`;

    logger.debug({ url }, '[wellfound:hiring] Navigating to hiring section');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    await browserManager.humanDelay(2000, 4000);

    if (await browserManager.detectCaptcha(page)) {
      logger.warn('[wellfound:hiring] CAPTCHA detected');
      return [];
    }

    await browserManager.humanScroll(page, 6);
    await browserManager.humanDelay(1000, 2000);

    const raw = await page.evaluate((): Array<{ name: string; slug: string }> => {
      const seen = new Set<string>();
      const out: Array<{ name: string; slug: string }> = [];

      document.querySelectorAll<HTMLAnchorElement>('a[href]').forEach(a => {
        const href = a.getAttribute('href') ?? '';
        const m = href.match(/\/company\/([^/?#]+)/);
        if (!m) return;
        const slug = m[1]!;
        if (seen.has(slug)) return;
        seen.add(slug);

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
        out.push({ name: slug.replace(/-/g, ' '), slug });
      });

      return out;
    });

    logger.debug({ count: raw.length }, '[wellfound:hiring] Company slugs extracted');

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

    const data = await page.evaluate((): {
      websiteUrl?: string; location?: string; empText?: string;
      stage?: string; description?: string;
      jobs: Array<{ title: string }>;
      founders: Array<{ fullName: string; roleText: string; linkedinUrl?: string }>;
    } => {
      const allText = Array.from(document.querySelectorAll('span, p, div'))
        .map(el => el.textContent?.trim() ?? '')
        .filter(t => t.length > 0 && t.length < 200);

      const websiteAnchor = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'))
        .find(a => !a.href.includes('wellfound.com') && !a.href.includes('linkedin.com') && !a.href.includes('twitter.com'));

      const location    = allText.find(t => /[A-Z][a-z]+(,\s*[A-Z]{2}|,\s*[A-Z][a-z]+)/.test(t) && t.length < 60) ?? '';
      const empText     = allText.find(t => /\d+[-–]\d+\s*(employees?)?|\d+\+\s*employees?/i.test(t)) ?? '';
      const stage       = allText.find(t => /seed|series [abc]|pre-seed|bootstrapped/i.test(t) && t.length < 40) ?? '';
      const description = (document.querySelector('meta[name="description"]') as HTMLMetaElement | null)?.content ?? '';

      const jobs = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href*="/jobs/"]'))
        .slice(0, 15)
        .map(a => ({ title: a.textContent?.trim() ?? '' }))
        .filter(j => j.title.length > 3);

      const founders: Array<{ fullName: string; roleText: string; linkedinUrl?: string }> = [];
      document.querySelectorAll<HTMLAnchorElement>('a[href*="linkedin.com/in/"]').forEach(a => {
        const container = a.closest('div, li') ?? a.parentElement;
        const nameEl = container?.querySelector('h3, h4, strong, [class*="name"]');
        const roleEl = container?.querySelector('p, span');
        const fullName = nameEl?.textContent?.trim() ?? '';
        if (!fullName || fullName.length < 3) return;
        founders.push({ fullName, roleText: roleEl?.textContent?.trim() ?? '', linkedinUrl: a.href });
      });

      return { websiteUrl: websiteAnchor?.href, location, empText, stage, description, jobs, founders };
    });

    let domain: string | undefined;
    if (data.websiteUrl) {
      try {
        domain = new URL(data.websiteUrl).hostname.replace(/^www\./, '');
      } catch { /* bad URL */ }
    }

    if (!domain) logger.debug({ slug: co.slug }, '[wellfound] No domain — will filter downstream');

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
      fundingStage:  mapStage(data.stage),
    };

    const jobs: RawJob[] = domain
      ? data.jobs.map(j => ({
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
        fullName:      f.fullName,
        firstName:     parts[0],
        lastName:      parts[parts.length - 1],
        role:          /ceo|founder|co-founder/i.test(f.roleText) ? 'Founder' as const : 'Unknown' as const,
        linkedinUrl:   f.linkedinUrl,
        companyDomain: domain,
      };
    });

    logger.info({ company: co.name, domain, jobs: jobs.length, contacts: contacts.length }, '[wellfound:company] Page scraped');

    return { source: 'wellfound', company: rawCompany, contacts, jobs, scrapedAt: new Date() };
  }
}

function parseEmployeeText(text: string): number | undefined {
  const match = text.match(/(\d+)\s*[-–]\s*(\d+)|(\d+)\+?/);
  if (!match) return undefined;
  if (match[1] && match[2]) return Math.floor((parseInt(match[1], 10) + parseInt(match[2], 10)) / 2);
  if (match[3]) return parseInt(match[3], 10);
  return undefined;
}

function mapStage(stage?: string): FundingStage {
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
    [/frontend|front.end/i, 'frontend'], [/backend|back.end/i, 'backend'],
    [/fullstack|full.stack/i, 'fullstack'], [/machine learning|ml/i, 'ml'],
    [/ai engineer|generative/i, 'generative-ai'], [/fastapi|django|flask/i, 'python'],
    [/graphql/i, 'graphql'], [/golang|go\b/i, 'golang'],
  ];
  return patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag);
}

export const wellfoundScraper = new WellfoundScraper();
