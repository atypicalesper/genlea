/**
 * Enrichment Agent
 *
 * Given a company, the agent autonomously decides:
 *   - What data is already available (get_company_state)
 *   - Which enrichment sources to try and in what order
 *   - When to use Playwright stealth as a fallback (API fails / rate-limited)
 *   - Whether the company should be disqualified (defunct, too large, wrong country)
 *   - When enough data has been gathered to proceed to scoring
 *   - If data is insufficient, it tries ALL available sources before giving up
 *
 * Contact persons are saved as a rich array with full details (role, email, LinkedIn, etc.)
 */

import axios from 'axios';
import { runAgent, AgentConfig, ToolDef, ToolHandler } from './base.agent.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { queueManager } from '../core/queue.manager.js';
import { indianRatioAnalyzer } from '../enrichment/dev-origin.analyzer.js';
import { contactResolver } from '../enrichment/contact.resolver.js';
import { websiteTeamScraper } from '../enrichment/website-team.enricher.js';
import { normalizer, normalizeRole } from '../enrichment/normalizer.js';
import { deduplicateContacts } from '../enrichment/deduplicator.js';
import { githubScraper, hunterScraper, clearbitScraper } from '../scrapers/enrichment/index.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { browserManager } from '../core/browser.manager.js';
import { proxyManager } from '../core/proxy.manager.js';
import { logger } from '../utils/logger.js';
import type { EnrichmentJobData, ContactRole } from '../types/index.js';

// ── Defunct detection ─────────────────────────────────────────────────────────
const DEFUNCT_PATTERNS = [
  /domain\s+(is\s+)?for\s+sale/i, /this\s+domain\s+has\s+(expired|been\s+suspended)/i,
  /account\s+suspended/i, /parked\s+(free\s+)?by\s+/i, /buy\s+this\s+domain/i,
  /company\s+(has\s+)?(closed|shut\s+down|ceased\s+operations)/i,
  /we\s+(are\s+|have\s+)?shut(ting)?\s+down/i, /no\s+longer\s+in\s+(business|operation)/i,
];

const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency that sells offshore Indian developer talent to US/UK/CA/EU tech startups.

Your job: given a company domain, gather comprehensive data about:
1. Tech stack (languages, frameworks, tools they use)
2. Employee count and funding stage
3. Key decision-maker contacts — CEO, CTO, VP of Engineering, Head of Engineering, Director of Engineering, HR, Head of Talent, Recruiter. Save ALL of them as a rich array with name, role, email, LinkedIn URL.
4. Indian-origin developer ratio (what fraction of their engineers appear to be of Indian origin)
5. Whether the company is still active and worth pursuing

Decision rules:
- ALWAYS start by checking current state (get_company_state) to avoid redundant work.
- If ANY critical data is missing or insufficient, try ALL available sources before giving up:
  * GitHub → tech stack + contributor names (free, no rate limit)
  * Clearbit → company metadata (employee count, funding, industry)
  * Website team page → names of team members
  * Hunter → emails for the domain
  * Contact resolver → SMTP verify + fill gaps
  * Playwright stealth → use when APIs fail, rate-limited, or return nothing
- If tech stack is unknown after GitHub: try website's /careers, /jobs, /stack pages via Playwright.
- If contacts are empty after Hunter: use Playwright to scrape the company's /team or /about page directly.
- Mark company as DEFUNCT and stop immediately if: DNS failure, 404 on root domain, parked page, or shutdown language on the website.
- Mark company as DISQUALIFIED if: employee count > 1000, or HQ is in India/non-target country.
- When data is sufficient (has tech stack + ≥5 names for ratio OR clear ratio + at least 1 contact), proceed to scoring.
- Always save partial data even if some steps fail — partial data is better than nothing.

Available sources to try (in roughly this order, but adapt based on what's missing):
1. get_company_state — always first
2. enrich_github — free, great for tech stack + developer names
3. enrich_clearbit — company metadata
4. scrape_website_team — /team /about pages, names + emails
5. enrich_hunter — email patterns for the domain
6. verify_contacts — SMTP verify + fill missing CEO/HR
7. playwright_scrape_url — stealth browser fallback, use when above fail
8. compute_origin_ratio — after gathering enough names
9. save_company_data — save partial enrichment results at any point
10. disqualify_company — if company should be excluded
11. queue_for_scoring — when enrichment is complete`;

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS: ToolDef[] = [
  {
    name: 'get_company_state',
    description: 'Get current state of the company from the database — what data we already have.',
    parameters: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
    },
  },
  {
    name: 'enrich_github',
    description: 'Find company GitHub org, extract tech stack from repos, and get contributor names for origin ratio analysis.',
    parameters: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain'],
    },
  },
  {
    name: 'enrich_clearbit',
    description: 'Fetch company metadata from Clearbit — employee count, funding stage, industry, location.',
    parameters: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain'],
    },
  },
  {
    name: 'scrape_website_team',
    description: 'Scrape company website /team /about /people pages for team member names and emails.',
    parameters: {
      type: 'object',
      properties: {
        websiteUrl: { type: 'string', description: 'Full URL e.g. https://acme.com' },
        domain:     { type: 'string' },
      },
      required: ['domain'],
    },
  },
  {
    name: 'enrich_hunter',
    description: 'Use Hunter.io to discover emails and contacts for a domain.',
    parameters: {
      type: 'object',
      properties: { domain: { type: 'string' } },
      required: ['domain'],
    },
  },
  {
    name: 'verify_contacts',
    description: 'SMTP-verify existing contacts and attempt to fill missing CEO/HR/CTO emails using known email patterns.',
    parameters: {
      type: 'object',
      properties: {
        companyId: { type: 'string' },
        domain:    { type: 'string' },
      },
      required: ['companyId', 'domain'],
    },
  },
  {
    name: 'playwright_scrape_url',
    description: 'Use a stealth Playwright browser to scrape any URL. Use as fallback when APIs fail or return no data. Good for /careers, /team, /about, /jobs pages.',
    parameters: {
      type: 'object',
      properties: {
        url:     { type: 'string', description: 'Full URL to scrape' },
        purpose: { type: 'string', description: 'What you are looking for: "team_names", "tech_stack", "contact_emails", "company_info"' },
      },
      required: ['url', 'purpose'],
    },
  },
  {
    name: 'save_contacts',
    description: 'Save an array of decision-maker contacts (CEO, CTO, VP Engineering, HR, etc.) with full details. Only saves contacts with known roles.',
    parameters: {
      type: 'object',
      properties: {
        companyId: { type: 'string' },
        contacts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              fullName:    { type: 'string' },
              role:        { type: 'string', description: 'CEO, CTO, VP of Engineering, Head of Engineering, Director of Engineering, HR, Recruiter, Founder, Co-Founder, COO, CPO, CFO, Head of Talent' },
              email:       { type: 'string' },
              linkedinUrl: { type: 'string' },
              phone:       { type: 'string' },
            },
            required: ['fullName', 'role'],
          },
        },
      },
      required: ['companyId', 'contacts'],
    },
  },
  {
    name: 'compute_origin_ratio',
    description: 'Analyse all collected names to estimate the fraction of Indian-origin developers. Call after gathering names from GitHub, website, and Hunter.',
    parameters: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
    },
  },
  {
    name: 'save_company_data',
    description: 'Save/merge partial company data (tech stack, employee count, funding, etc.) to the database.',
    parameters: {
      type: 'object',
      properties: {
        domain:        { type: 'string' },
        name:          { type: 'string' },
        techStack:     { type: 'array', items: { type: 'string' } },
        employeeCount: { type: 'number' },
        fundingStage:  { type: 'string' },
        hqCountry:     { type: 'string' },
        websiteUrl:    { type: 'string' },
        githubOrg:     { type: 'string' },
      },
      required: ['domain', 'name'],
    },
  },
  {
    name: 'disqualify_company',
    description: 'Mark the company as disqualified and stop enrichment. Use for: defunct websites, employee count > 1000, Indian HQ, no tech signal.',
    parameters: {
      type: 'object',
      properties: {
        companyId: { type: 'string' },
        reason:    { type: 'string' },
      },
      required: ['companyId', 'reason'],
    },
  },
  {
    name: 'queue_for_scoring',
    description: 'Send the company to the scoring queue. Call when enrichment is complete.',
    parameters: {
      type: 'object',
      properties: {
        companyId: { type: 'string' },
        runId:     { type: 'string' },
      },
      required: ['companyId', 'runId'],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

function makeHandlers(job: EnrichmentJobData): Record<string, ToolHandler> {
  const { runId, companyId, domain } = job;

  return {
    get_company_state: async () => {
      const company  = await companyRepository.findById(companyId);
      const contacts = await contactRepository.findByCompanyId(companyId);
      const nameCount = (await contactRepository.findAllNamesForOriginRatio(companyId)).length;
      if (!company) return { error: 'Company not found' };
      return {
        name:          company.name,
        domain:        company.domain,
        websiteUrl:    company.websiteUrl,
        employeeCount: company.employeeCount,
        hqCountry:     company.hqCountry,
        fundingStage:  company.fundingStage,
        techStack:     company.techStack ?? [],
        originRatio:   company.originRatio,
        totalNamesCollected: nameCount,
        contacts: contacts.map(c => ({ role: c.role, fullName: c.fullName, hasEmail: !!c.email, emailVerified: c.emailVerified })),
        status:        company.status,
        lastEnrichedAt: company.lastEnrichedAt,
        missing: {
          techStack:    (company.techStack?.length ?? 0) === 0,
          employeeCount: !company.employeeCount,
          contacts:     contacts.length === 0,
          originRatio:  !company.originRatio,
          names:        nameCount < 5,
        },
      };
    },

    enrich_github: async () => {
      const result = await githubScraper.enrichOrg(domain);
      if (!result?.company) return { found: false, reason: 'No GitHub org found for domain' };

      await companyRepository.upsert({ ...result.company, domain, name: (await companyRepository.findById(companyId))?.name ?? '' });

      let namesSaved = 0;
      if (result.contacts?.length) {
        await Promise.allSettled(
          result.contacts.filter(c => c.fullName).map(c =>
            contactRepository.upsert({
              ...c, companyId, fullName: c.fullName!, role: c.role ?? 'Unknown', forOriginRatio: true,
            })
          )
        );
        namesSaved = result.contacts.filter(c => c.fullName).length;
      }

      return {
        found:       true,
        githubOrg:   result.company.githubOrg,
        techStack:   result.company.techStack ?? [],
        namesSaved,
      };
    },

    enrich_clearbit: async () => {
      const result = await clearbitScraper.enrichDomain(domain).catch(() => null);
      if (!result?.company) return { found: false };

      const company = await companyRepository.findById(companyId);
      await companyRepository.upsert({ ...result.company, domain, name: company?.name ?? '' });

      return {
        found:         true,
        employeeCount: result.company.employeeCount,
        fundingStage:  result.company.fundingStage,
        hqCountry:     result.company.hqCountry,
        industry:      result.company.industry,
      };
    },

    scrape_website_team: async ({ websiteUrl: url, domain: d }) => {
      const targetUrl = (url as string | undefined) || `https://${d ?? domain}`;
      const members = await websiteTeamScraper.scrapeTeam(targetUrl, d as string ?? domain).catch(() => []);

      if (!members.length) return { found: false, count: 0 };

      await Promise.allSettled(
        members.map(p =>
          contactRepository.upsert({
            companyId,
            fullName:       p.fullName,
            firstName:      p.fullName.split(' ')[0],
            lastName:       p.fullName.split(' ').at(-1),
            role:           'Unknown',
            linkedinUrl:    p.linkedinUrl,
            email:          p.email,
            sources:        ['website'],
            forOriginRatio: true,
          })
        )
      );

      return { found: true, count: members.length, names: members.map(m => m.fullName) };
    },

    enrich_hunter: async () => {
      const result = await hunterScraper.enrichDomain(domain);
      if (!result?.contacts?.length) return { found: false };

      const { contacts: raw } = normalizer.processResults([result]);
      const deduped = deduplicateContacts(raw);
      let saved = 0;

      for (const c of deduped) {
        if (!c.role || c.role === 'Unknown') continue; // skip unknown roles
        await contactRepository.upsert({
          ...c, companyId, fullName: c.fullName ?? '', role: c.role,
        }).catch(() => {});
        saved++;
      }

      return { found: true, contactsFound: result.contacts.length, savedDecisionMakers: saved };
    },

    verify_contacts: async () => {
      await contactResolver.resolveForCompany(companyId, domain).catch(err =>
        logger.warn({ err, domain }, '[enrichment.agent] Contact resolution failed — continuing')
      );
      const contacts = await contactRepository.findByCompanyId(companyId);
      return {
        totalContacts:  contacts.length,
        verifiedEmails: contacts.filter(c => c.emailVerified).length,
        contacts: contacts.map(c => ({
          role: c.role, fullName: c.fullName, email: c.email, emailVerified: c.emailVerified, linkedinUrl: c.linkedinUrl,
        })),
      };
    },

    playwright_scrape_url: async ({ url, purpose }) => {
      const browserId = `agent-${companyId.slice(-8)}`;
      let context: Awaited<ReturnType<typeof browserManager.createContext>> | null = null;
      try {
        const proxy = proxyManager.getProxy();
        context = await browserManager.createContext(browserId, { proxy });
        const page = await browserManager.newPage(context);

        await page.goto(url as string, { waitUntil: 'domcontentloaded', timeout: 15000 });
        await browserManager.humanDelay(1000, 3000);

        const text = await page.innerText('body').catch(() => '');
        const html = await page.content();

        // Check for defunct signals
        if (DEFUNCT_PATTERNS.some(re => re.test(html) || re.test(text))) {
          return { defunct: true, reason: 'Shutdown/parked signals detected' };
        }

        // Extract emails from page
        const emails = [...html.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)]
          .map(m => m[0]!.toLowerCase())
          .filter(e => e.includes(domain as string))
          .slice(0, 20);

        // Extract LinkedIn profile links
        const linkedinUrls = [...html.matchAll(/https:\/\/www\.linkedin\.com\/in\/[a-zA-Z0-9\-_]+/g)]
          .map(m => m[0])
          .slice(0, 20);

        // Extract tech keywords
        const techKeywords = ['react','vue','angular','node','nodejs','python','django','flask','fastapi',
          'ruby','rails','golang','go','java','spring','kotlin','swift','typescript','nextjs',
          'aws','gcp','azure','docker','kubernetes','postgres','mongodb','redis','graphql']
          .filter(kw => text.toLowerCase().includes(kw));

        return {
          defunct:      false,
          purpose,
          textLength:   text.length,
          emails:       [...new Set(emails)],
          linkedinUrls: [...new Set(linkedinUrls)],
          techKeywords: [...new Set(techKeywords)],
          excerpt:      text.slice(0, 800),
        };
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? '';
        if (['ENOTFOUND', 'ECONNREFUSED'].includes(code)) return { defunct: true, reason: 'Domain unreachable' };
        return { error: err instanceof Error ? err.message : String(err) };
      } finally {
        if (context) await context.close().catch(() => {});
      }
    },

    save_contacts: async ({ companyId: cid, contacts }) => {
      const list = contacts as Array<Record<string, unknown>>;
      let saved = 0;

      for (const c of list) {
        if (!c.fullName || !c.role) continue;
        const role = normalizeRole(String(c.role)) as ContactRole;
        if (role === 'Unknown') continue; // enforce — no unknown roles in contacts

        await contactRepository.upsert({
          companyId: cid as string ?? companyId,
          fullName:    String(c.fullName),
          firstName:   String(c.fullName).split(' ')[0],
          lastName:    String(c.fullName).split(' ').at(-1),
          role,
          email:       c.email as string | undefined,
          linkedinUrl: c.linkedinUrl as string | undefined,
          phone:       c.phone as string | undefined,
          sources:     ['agent'],
          forOriginRatio: false,
        }).catch(() => {});
        saved++;
      }

      return { saved, total: list.length };
    },

    compute_origin_ratio: async () => {
      const settings  = await settingsRepository.get();
      const allNames  = await contactRepository.findAllNamesForOriginRatio(companyId);
      const nameList  = allNames.filter(n => n.fullName);

      if (nameList.length < settings.originRatioMinSample) {
        return { computed: false, reason: `Insufficient names: ${nameList.length} < ${settings.originRatioMinSample} required` };
      }

      const result = await indianRatioAnalyzer.analyzeNames(nameList);
      const company = await companyRepository.findById(companyId);

      await companyRepository.upsert({
        domain,
        name:              company?.name ?? '',
        originDevCount:    result.indianCount,
        totalDevCount:     result.totalCount,
        originRatio:       result.ratio,
        toleranceIncluded: result.ratio < 0.75 && result.ratio >= settings.originRatioThreshold,
      });

      return {
        computed:     true,
        ratio:        result.ratio,
        indianCount:  result.indianCount,
        totalCount:   result.totalCount,
        reliable:     result.reliable,
        meetsThreshold: result.ratio >= settings.originRatioThreshold,
      };
    },

    save_company_data: async (data) => {
      const company = await companyRepository.findById(companyId);
      await companyRepository.upsert({
        ...data,
        domain,
        name: data.name as string ?? company?.name ?? '',
      } as any);
      return { saved: true };
    },

    disqualify_company: async ({ reason }) => {
      await companyRepository.disqualify(companyId);
      logger.info({ domain, reason }, '[enrichment.agent] Disqualified');
      return { disqualified: true, reason };
    },

    queue_for_scoring: async () => {
      await companyRepository.upsert({ domain, name: '', lastEnrichedAt: new Date() });
      await queueManager.addScoringJob({ runId, companyId });
      return { queued: true };
    },
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export async function runEnrichmentAgent(job: EnrichmentJobData): Promise<void> {
  const { runId, companyId, domain, force } = job;
  const startedAt = Date.now();

  const company = await companyRepository.findById(companyId);
  if (!company) {
    logger.warn({ companyId, domain }, '[enrichment.agent] Company not found — skipping');
    return;
  }

  // Size guard
  if (company.employeeCount && company.employeeCount > 1000) {
    await companyRepository.disqualify(companyId);
    return;
  }

  // Cooldown guard — 7 days
  const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
  if (!force && company.lastEnrichedAt) {
    const ageMs = Date.now() - new Date(company.lastEnrichedAt).getTime();
    if (ageMs < COOLDOWN_MS) {
      logger.info({ domain, ageHours: (ageMs / 3_600_000).toFixed(1) }, '[enrichment.agent] Cooldown — queuing scoring only');
      await queueManager.addScoringJob({ runId, companyId });
      return;
    }
  }

  const config: AgentConfig = {
    name: `enrichment:${domain}`,
    systemPrompt: SYSTEM_PROMPT,
    tools: TOOLS,
    handlers: makeHandlers(job),
    maxIterations: 18,
  };

  const userMessage = `
Enrich this company for lead scoring:

Company ID : ${companyId}
Domain     : ${domain}
Name       : ${company.name}
Website    : ${company.websiteUrl ?? 'unknown'}
Known data : employee count=${company.employeeCount ?? 'unknown'}, tech stack=${JSON.stringify(company.techStack ?? [])}, status=${company.status}

Steps:
1. Call get_company_state first to see what's already available.
2. Fill ALL missing fields — if data is insufficient, try every available source.
3. Gather decision-maker contacts (CEO, CTO, VP Engineering, Head of Engineering, HR) and save them all as a detailed array via save_contacts.
4. Collect as many names as possible for Indian-origin ratio analysis (target ≥ 10 names).
5. Disqualify immediately if company is defunct or too large.
6. When enrichment is done, call compute_origin_ratio then queue_for_scoring.
`.trim();

  try {
    await runAgent(config, userMessage);
    logger.info({ domain, durationMs: Date.now() - startedAt }, '[enrichment.agent] Complete');
  } catch (err) {
    logger.error({ err, domain }, '[enrichment.agent] Failed');
    throw err;
  }
}
