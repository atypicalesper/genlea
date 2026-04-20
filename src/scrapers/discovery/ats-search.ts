import { logger } from '../../utils/logger.js';

/**
 * Scraper-friendly search via DuckDuckGo HTML endpoint.
 * Used to find ATS board URLs (e.g. `site:boards.greenhouse.io <keywords>`)
 * without triggering Google CAPTCHAs.
 */
export async function duckDuckGoSearch(query: string, limit = 60): Promise<string[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
        'Accept':          'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, query }, '[ats-search] DuckDuckGo non-OK');
      return [];
    }

    const html = await res.text();
    const urls: string[] = [];
    const seen = new Set<string>();

    const anchorRe = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"/gi;
    let match: RegExpExecArray | null;
    while ((match = anchorRe.exec(html)) !== null && urls.length < limit) {
      let href = match[1]!;
      // DDG sometimes wraps hrefs in redirect: //duckduckgo.com/l/?uddg=<enc>
      const uddg = href.match(/uddg=([^&]+)/);
      if (uddg?.[1]) href = decodeURIComponent(uddg[1]);
      if (href.startsWith('//')) href = 'https:' + href;
      if (!/^https?:\/\//i.test(href)) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      urls.push(href);
    }

    logger.debug({ query, count: urls.length }, '[ats-search] DuckDuckGo results');
    return urls;
  } catch (err) {
    logger.warn({ err, query }, '[ats-search] DuckDuckGo search failed');
    return [];
  }
}

/** Extract unique slugs from a list of URLs matching a regex with one capture group. */
export function extractSlugs(urls: string[], slugRe: RegExp): string[] {
  const slugs = new Set<string>();
  for (const u of urls) {
    const m = u.match(slugRe);
    if (m?.[1]) slugs.add(m[1]!.toLowerCase());
  }
  return [...slugs];
}

/** Minimal tech-tag extractor shared across ATS scrapers. */
export function extractTechFromTitle(title: string): string[] {
  const patterns: [RegExp, string][] = [
    [/node\.?js|nodejs/i, 'nodejs'],    [/react(?!.?native)/i, 'react'],
    [/react native/i, 'react-native'],  [/next\.?js/i, 'nextjs'],
    [/nest\.?js/i, 'nestjs'],           [/python/i, 'python'],
    [/typescript/i, 'typescript'],      [/javascript/i, 'javascript'],
    [/frontend|front.end/i, 'frontend'],[/backend|back.end/i, 'backend'],
    [/fullstack|full.stack/i, 'fullstack'],
    [/machine learning|ml engineer/i, 'ml'],
    [/ai engineer|generative ai|llm/i, 'generative-ai'],
    [/fastapi|django|flask/i, 'python'],[/graphql/i, 'graphql'],
    [/golang|go\b/i, 'golang'],         [/java\b/i, 'java'],
    [/ruby|rails/i, 'ruby'],            [/rust\b/i, 'rust'],
    [/swift|ios/i, 'ios'],              [/android|kotlin/i, 'android'],
    [/devops|sre|platform engineer/i, 'devops'],
    [/data engineer|spark|airflow/i, 'data-engineering'],
    [/cloud|aws|gcp|azure/i, 'cloud'],  [/mobile/i, 'mobile'],
    [/software engineer|software developer|swe\b/i, 'software'],
    [/staff engineer|principal engineer|senior engineer/i, 'software'],
  ];
  const tags = [...new Set(patterns.filter(([re]) => re.test(title)).map(([, tag]) => tag))];
  return tags.length ? tags : ['software'];
}
