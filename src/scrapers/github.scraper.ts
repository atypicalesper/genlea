import axios, { AxiosInstance } from 'axios';
import {
  Scraper, ScrapeQuery, RawResult, RawCompany,
} from '../types/index.js';
import { logger } from '../utils/logger.js';
import { chunkArray } from '../utils/random.js';

export class GitHubScraper implements Scraper {
  name = 'github' as const;
  private client: AxiosInstance;

  constructor() {
    this.client = axios.create({
      baseURL: 'https://api.github.com',
      timeout: 10000,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(process.env['GITHUB_TOKEN']
          ? { Authorization: `Bearer ${process.env['GITHUB_TOKEN']}` }
          : {}),
      },
    });
  }

  async isAvailable(): Promise<boolean> {
    if (!process.env['GITHUB_TOKEN']) {
      logger.warn('[github] GITHUB_TOKEN not set — using unauthenticated (60 req/hr limit)');
    }
    return true; // works without token at lower rate
  }

  async scrape(_query: ScrapeQuery): Promise<RawResult[]> {
    logger.warn('[github] Use enrichOrg() directly for domain→tech-stack enrichment');
    return [];
  }

  /**
   * Given a company domain, find their GitHub org and return tech stack.
   * Called from the enrichment worker after company upsert.
   */
  async enrichOrg(domain: string): Promise<RawResult | null> {
    const orgName = await this.findOrgName(domain);
    if (!orgName) {
      logger.debug({ domain }, '[github] No GitHub org found');
      return null;
    }

    logger.info({ domain, orgName }, '[github] GitHub org found — fetching repos');

    try {
      const [techStack, devCount] = await Promise.all([
        this.getOrgTechStack(orgName),
        this.getOrgDevCount(orgName),
      ]);

      logger.info(
        { domain, orgName, techStack, devCount },
        '[github] Org enrichment complete'
      );

      const rawCompany: Partial<RawCompany> = {
        domain,
        techStack,
        employeeCount: devCount ?? undefined,
        githubOrg: orgName,
      };

      return {
        source: 'github',
        company: rawCompany,
        scrapedAt: new Date(),
      };
    } catch (err) {
      logger.error({ err, orgName, domain }, '[github] Org enrichment failed');
      return null;
    }
  }

  /** Try to resolve GitHub org name from company domain */
  private async findOrgName(domain: string): Promise<string | null> {
    // Heuristic: company domain without TLD is often the GitHub org name
    const slug = domain.replace(/\.(com|io|ai|co|dev|net|org)$/, '');
    logger.debug({ domain, slug }, '[github] Trying org slug');

    try {
      const res = await this.client.get(`/orgs/${slug}`);
      if (res.status === 200) return slug;
    } catch {
      // try search API
    }

    try {
      const res = await this.client.get<{ items: Array<{ login: string }> }>(
        `/search/users?q=${slug}+type:org&per_page=3`
      );
      const match = res.data.items.find(i =>
        i.login.toLowerCase().includes(slug.toLowerCase())
      );
      if (match) return match.login;
    } catch (err) {
      logger.debug({ err, domain }, '[github] Org search failed');
    }

    return null;
  }

  /** Get language breakdown for org's top repos → map to tech tags */
  private async getOrgTechStack(orgName: string): Promise<string[]> {
    logger.debug({ orgName }, '[github:tech] Fetching repos');

    const res = await this.client.get<Array<{ name: string; language: string | null }>>(
      `/orgs/${orgName}/repos?sort=updated&per_page=30`
    );

    const repos = res.data;
    const langCounts: Record<string, number> = {};

    // Get language breakdown for top 10 repos
    const topRepos = repos.slice(0, 10);
    const langResults = await Promise.allSettled(
      topRepos.map(r => this.client.get<Record<string, number>>(`/repos/${orgName}/${r.name}/languages`))
    );

    for (const result of langResults) {
      if (result.status === 'fulfilled') {
        for (const [lang, bytes] of Object.entries(result.value.data)) {
          langCounts[lang] = (langCounts[lang] ?? 0) + bytes;
        }
      }
    }

    const LANG_TO_TAG: Record<string, string> = {
      'TypeScript': 'typescript', 'JavaScript': 'nodejs',
      'Python': 'python', 'Go': 'golang', 'Rust': 'rust',
      'Java': 'java', 'Kotlin': 'kotlin', 'Swift': 'ios',
      'Dart': 'flutter', 'Ruby': 'ruby', 'PHP': 'php',
      'C#': 'dotnet', 'C++': 'cpp', 'Scala': 'scala',
    };

    const tags = Object.keys(langCounts)
      .sort((a, b) => (langCounts[b] ?? 0) - (langCounts[a] ?? 0))
      .slice(0, 6)
      .map(lang => LANG_TO_TAG[lang] ?? lang.toLowerCase())
      .filter(Boolean);

    logger.debug({ orgName, tags }, '[github:tech] Tech stack resolved');
    return tags;
  }

  /** Count unique contributors across recent repos as proxy for dev team size */
  private async getOrgDevCount(orgName: string): Promise<number | null> {
    try {
      const res = await this.client.get<Array<{ name: string }>>(
        `/orgs/${orgName}/repos?sort=pushed&per_page=5`
      );
      const repos = res.data.slice(0, 3);
      const contributorSets = await Promise.allSettled(
        repos.map(r =>
          this.client.get<Array<{ login: string }>>(
            `/repos/${orgName}/${r.name}/contributors?per_page=100`
          )
        )
      );

      const logins = new Set<string>();
      for (const r of contributorSets) {
        if (r.status === 'fulfilled') {
          r.value.data.forEach(c => logins.add(c.login));
        }
      }

      logger.debug({ orgName, uniqueContributors: logins.size }, '[github:devs] Dev count estimate');
      return logins.size > 0 ? logins.size : null;
    } catch (err) {
      logger.debug({ err, orgName }, '[github:devs] Could not count contributors');
      return null;
    }
  }
}

export const githubScraper = new GitHubScraper();
