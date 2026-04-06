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
 * Workers call runEnrichmentAgent() — no manual intervention needed.
 */

import { z }                from 'zod';
import { tool }             from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { runAgent }              from './base.agent.js';
import { alertAgentFailure }     from '../utils/alert.js';
import { companyRepository }       from '../storage/repositories/company.repository.js';
import { contactRepository }       from '../storage/repositories/contact.repository.js';
import { queueManager }            from '../core/queue.manager.js';
import { indianRatioAnalyzer }     from '../enrichment/dev-origin.analyzer.js';
import { contactResolver }         from '../enrichment/contact.resolver.js';
import { websiteTeamScraper }      from '../enrichment/website-team.enricher.js';
import { normalizer, normalizeRole } from '../enrichment/normalizer.js';
import { deduplicateContacts }     from '../enrichment/deduplicator.js';
import { githubScraper, hunterScraper, clearbitScraper, exploriumScraper } from '../scrapers/enrichment/index.js';
import { settingsRepository }      from '../storage/repositories/settings.repository.js';
import { browserManager }          from '../core/browser.manager.js';
import { proxyManager }            from '../core/proxy.manager.js';
import { logger }                  from '../utils/logger.js';
import type { EnrichmentJobData, ContactRole } from '../types/index.js';

// ── Defunct detection ─────────────────────────────────────────────────────────

const DEFUNCT_PATTERNS = [
  /domain\s+(is\s+)?for\s+sale/i, /this\s+domain\s+has\s+(expired|been\s+suspended)/i,
  /account\s+suspended/i, /parked\s+(free\s+)?by\s+/i, /buy\s+this\s+domain/i,
  /company\s+(has\s+)?(closed|shut\s+down|ceased\s+operations)/i,
  /we\s+(are\s+|have\s+)?shut(ting)?\s+down/i, /no\s+longer\s+in\s+(business|operation)/i,
];

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a B2B lead enrichment agent for a software agency that sells offshore Indian developer talent to US/UK/CA/EU tech startups.

Your job: given a company domain, gather comprehensive data about:
1. Tech stack (languages, frameworks, tools they use)
2. Employee count and funding stage
3. Key decision-maker contacts — CEO, CTO, VP of Engineering, Head of Engineering, Director of Engineering, HR, Head of Talent, Recruiter. Save ALL of them as a rich array with name, role, email, LinkedIn URL.
4. Indian-origin developer ratio (what fraction of their engineers appear to be of Indian origin)
5. Whether the company is still active and worth pursuing

CRITICAL — availability rule:
If a tool returns { available: false }, skip it immediately — do NOT retry it. Some tools require API keys that may not be configured. In that case, playwright_scrape_url is your primary data source; it requires no API key and works for any URL.

Decision rules:
- ALWAYS start with get_company_state.
- enrich_github is free and always worth trying — great for tech stack + dev names.
- scrape_website_team is free — always try it.
- If enrich_clearbit returns available:false → skip it; use playwright_scrape_url on the company homepage to find employee count, funding info, description instead.
- If enrich_hunter returns available:false → skip it; use playwright_scrape_url on /team, /about, /contact, /people pages to collect emails and names.
- If tech stack is still missing → playwright_scrape_url on /careers, /jobs, /stack, /engineering pages.
- Mark DEFUNCT and stop if: DNS failure, 404, parked page, or shutdown language detected.
- Mark DISQUALIFIED if: employee count > 1000, or HQ is India/non-target country.
- When sufficient data is collected (tech stack + ≥5 names for ratio OR 1+ contact), proceed to scoring.
- Always save partial data — partial data is better than nothing.

Source order (skip if available:false):
1. get_company_state — always first
2. enrich_explorium — best single source: returns company metadata + contacts with email/phone/LinkedIn in one call (requires EXPLORIUM_API_KEY)
3. enrich_github — free, no key required — great for tech stack + dev names
4. enrich_clearbit — requires CLEARBIT_API_KEY — skip if Explorium already returned metadata
5. scrape_website_team — free, no key required
6. playwright_scrape_url — free, no key required — use aggressively on /team /about /careers /contact
7. enrich_hunter — requires HUNTER_API_KEY — skip if Explorium already returned contacts
8. verify_contacts — SMTP verify + fill gaps
9. compute_origin_ratio — after gathering names
10. save_company_data — save partial results anytime
11. disqualify_company — if company should be excluded
12. queue_for_scoring — when enrichment is complete`;

// ── Tool factory ──────────────────────────────────────────────────────────────

function makeTools(job: EnrichmentJobData): StructuredToolInterface[] {
  const { runId, companyId, domain } = job;

  return [
    // ── get_company_state ─────────────────────────────────────────────────────
    tool(
      async () => {
        const company   = await companyRepository.findById(companyId);
        const contacts  = await contactRepository.findByCompanyId(companyId);
        const nameCount = (await contactRepository.findAllNamesForOriginRatio(companyId)).length;
        if (!company) return JSON.stringify({ error: 'Company not found' });
        return JSON.stringify({
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
        });
      },
      {
        name:        'get_company_state',
        description: 'Get current state of the company from the database — what data we already have.',
        schema: z.object({ companyId: z.string() }),
      },
    ),

    // ── enrich_github ─────────────────────────────────────────────────────────
    tool(
      async () => {
        const result = await githubScraper.enrichOrg(domain);
        if (!result?.company) return JSON.stringify({ found: false, reason: 'No GitHub org found for domain' });

        await companyRepository.upsert({
          ...result.company, domain,
          name: (await companyRepository.findById(companyId))?.name ?? '',
        });

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

        return JSON.stringify({ found: true, githubOrg: result.company.githubOrg, techStack: result.company.techStack ?? [], namesSaved });
      },
      {
        name:        'enrich_github',
        description: 'Find company GitHub org, extract tech stack from repos, and get contributor names for origin ratio analysis.',
        schema: z.object({ domain: z.string() }),
      },
    ),

    // ── enrich_explorium ──────────────────────────────────────────────────────
    tool(
      async ({ name: companyName }) => {
        if (!process.env['EXPLORIUM_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'EXPLORIUM_API_KEY not configured' });
        }
        const result = await exploriumScraper.enrichDomain(domain, companyName).catch(() => null);
        if (!result) return JSON.stringify({ found: false });

        const company = await companyRepository.findById(companyId);
        if (result.company) {
          await companyRepository.upsert({ ...result.company, domain, name: company?.name ?? '' });
        }

        let contactsSaved = 0;
        if (result.contacts?.length) {
          const validContacts = result.contacts.filter(c => c.fullName && c.role && c.role !== 'Unknown');
          await Promise.allSettled(
            validContacts.map(c =>
              contactRepository.upsert({
                companyId,
                fullName:        c.fullName!,
                firstName:       c.firstName,
                lastName:        c.lastName,
                role:            c.role!,
                email:           c.email,
                emailConfidence: c.emailConfidence ?? 0,
                phone:           c.phone,
                linkedinUrl:     c.linkedinUrl,
                sources:         ['explorium'],
                forOriginRatio:  false,
              }).catch(err => logger.debug({ err, domain }, '[enrichment.agent] Explorium contact save failed'))
            )
          );
          contactsSaved = validContacts.length;
        }

        return JSON.stringify({
          found:         true,
          employeeCount: result.company?.employeeCount,
          fundingStage:  result.company?.fundingStage,
          hqCountry:     result.company?.hqCountry,
          techStack:     result.company?.techStack ?? [],
          contactsSaved,
          contacts: result.contacts?.map(c => ({ name: c.fullName, role: c.role, email: c.email, phone: c.phone, linkedin: c.linkedinUrl })),
        });
      },
      {
        name:        'enrich_explorium',
        description: 'Fetch company metadata AND decision-maker contacts (with email, phone, LinkedIn) from Explorium. Returns tech stack, funding, employee count, and verified contacts in one call. Prefer this over Clearbit + Hunter combined when available.',
        schema: z.object({
          domain: z.string(),
          name:   z.string().optional().describe('Company name (improves match accuracy)'),
        }),
      },
    ),

    // ── enrich_clearbit ───────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['CLEARBIT_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'CLEARBIT_API_KEY not configured — use playwright_scrape_url on the company homepage instead' });
        }
        const result = await clearbitScraper.enrichDomain(domain).catch(() => null);
        if (!result?.company) return JSON.stringify({ found: false });

        const company = await companyRepository.findById(companyId);
        await companyRepository.upsert({ ...result.company, domain, name: company?.name ?? '' });

        return JSON.stringify({
          found:         true,
          employeeCount: result.company.employeeCount,
          fundingStage:  result.company.fundingStage,
          hqCountry:     result.company.hqCountry,
          industry:      result.company.industry,
        });
      },
      {
        name:        'enrich_clearbit',
        description: 'Fetch company metadata from Clearbit — employee count, funding stage, industry, location.',
        schema: z.object({ domain: z.string() }),
      },
    ),

    // ── scrape_website_team ───────────────────────────────────────────────────
    tool(
      async ({ websiteUrl: url, domain: d }) => {
        const targetUrl = url || `https://${d ?? domain}`;
        const members = await websiteTeamScraper.scrapeTeam(targetUrl, d ?? domain).catch(() => []);
        if (!members.length) return JSON.stringify({ found: false, count: 0 });

        await Promise.allSettled(
          members.map(p =>
            contactRepository.upsert({
              companyId,
              fullName:       p.fullName,
              firstName:      p.fullName.split(' ')[0],
              lastName:       p.fullName.split(' ').at(-1),
              role:           normalizeRole(p.role),
              linkedinUrl:    p.linkedinUrl,
              email:          p.email,
              phone:          p.phone,
              sources:        ['website'],
              forOriginRatio: true,
            })
          )
        );

        const decisionMakers = members
          .filter(p => p.role && normalizeRole(p.role) !== 'Unknown')
          .map(p => ({ name: p.fullName, role: p.role, email: p.email ?? null, phone: p.phone ?? null, linkedin: p.linkedinUrl ?? null }));

        return JSON.stringify({ found: true, count: members.length, names: members.map(m => m.fullName), decisionMakers });
      },
      {
        name:        'scrape_website_team',
        description: 'Scrape company website /team /about /people pages for team member names and emails.',
        schema: z.object({
          websiteUrl: z.string().optional().describe('Full URL e.g. https://acme.com'),
          domain:     z.string(),
        }),
      },
    ),

    // ── enrich_hunter ────────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['HUNTER_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'HUNTER_API_KEY not configured — use playwright_scrape_url on /team or /contact pages instead' });
        }
        const result = await hunterScraper.enrichDomain(domain);
        if (!result?.contacts?.length) return JSON.stringify({ found: false });

        const { contacts: raw } = normalizer.processResults([result]);
        const deduped = deduplicateContacts(raw);
        const validDeduped = deduped.filter(c => c.role && c.role !== 'Unknown');

        await Promise.allSettled(
          validDeduped.map(c =>
            contactRepository.upsert({
              ...c, companyId, fullName: c.fullName ?? '', role: c.role!,
            }).catch(err => logger.debug({ err, domain }, '[enrichment.agent] Hunter contact save failed'))
          )
        );

        return JSON.stringify({ found: true, contactsFound: result.contacts.length, savedDecisionMakers: validDeduped.length });
      },
      {
        name:        'enrich_hunter',
        description: 'Use Hunter.io to discover emails and contacts for a domain.',
        schema: z.object({ domain: z.string() }),
      },
    ),

    // ── verify_contacts ───────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['HUNTER_API_KEY'] && !process.env['SMTP_HOST']) {
          return JSON.stringify({ available: false, reason: 'No HUNTER_API_KEY or SMTP_HOST configured — skipping contact verification' });
        }
        await contactResolver.resolveForCompany(companyId, domain).catch(err =>
          logger.warn({ err, domain }, '[enrichment.agent] Contact resolution failed — continuing')
        );
        const contacts = await contactRepository.findByCompanyId(companyId);
        return JSON.stringify({
          totalContacts:  contacts.length,
          verifiedEmails: contacts.filter(c => c.emailVerified).length,
          contacts: contacts.map(c => ({ role: c.role, fullName: c.fullName, email: c.email, emailVerified: c.emailVerified, linkedinUrl: c.linkedinUrl })),
        });
      },
      {
        name:        'verify_contacts',
        description: 'SMTP-verify existing contacts and attempt to fill missing CEO/HR/CTO emails using known email patterns.',
        schema: z.object({
          companyId: z.string(),
          domain:    z.string(),
        }),
      },
    ),

    // ── playwright_scrape_url ─────────────────────────────────────────────────
    tool(
      async ({ url, purpose }) => {
        const browserId = `agent-${companyId.slice(-8)}`;
        let context: Awaited<ReturnType<typeof browserManager.createContext>> | null = null;
        try {
          const proxy = proxyManager.getProxy();
          context = await browserManager.createContext(browserId, { proxy });
          const page = await browserManager.newPage(context);

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await browserManager.humanDelay(1000, 3000);

          const text = await page.innerText('body').catch(() => '');
          const html = await page.content();

          if (DEFUNCT_PATTERNS.some(re => re.test(html) || re.test(text))) {
            return JSON.stringify({ defunct: true, reason: 'Shutdown/parked signals detected' });
          }

          // JSON-LD Person schema
          type PersonCandidate = { name: string; role?: string; email?: string; phone?: string; linkedin?: string };
          const jsonldPeople: Array<{ name?: string; email?: string; telephone?: string; url?: string; jobTitle?: string }> = [];
          const jsonldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
          for (const block of jsonldBlocks) {
            try {
              const parsed = JSON.parse(block[1]!);
              const items = Array.isArray(parsed) ? parsed : [parsed];
              for (const item of items) {
                if (item['@type'] === 'Person') jsonldPeople.push(item);
                if (item['@type'] === 'Organization' && Array.isArray(item.employee)) {
                  jsonldPeople.push(...item.employee.filter((e: any) => e['@type'] === 'Person'));
                }
              }
            } catch { /* ignore malformed JSON-LD */ }
          }

          const candidates = new Map<string, PersonCandidate>();

          for (const p of jsonldPeople) {
            if (!p.name) continue;
            candidates.set(p.name.toLowerCase(), {
              name:     p.name,
              role:     p.jobTitle,
              email:    p.email,
              phone:    p.telephone,
              linkedin: p.url?.includes('linkedin.com') ? p.url : undefined,
            });
          }

          // LinkedIn anchor extraction
          const liMatches = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/(?:www\.)?linkedin\.com\/in\/[^/"']+)[^>]*>([^<]{3,60})<\/a>/gi)];
          for (const m of liMatches) {
            const liUrl   = m[1]!;
            const nameRaw = m[2]!.trim().replace(/\s+/g, ' ');
            if (/follow|connect|view|profile|linkedin|click|here|share/i.test(nameRaw)) continue;
            if (!/^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/.test(nameRaw)) continue;
            const key = nameRaw.toLowerCase();
            if (!candidates.has(key)) candidates.set(key, { name: nameRaw });
            candidates.get(key)!.linkedin = liUrl;
            const matchIdx = (m as any).index ?? 0;
            const ctx = html.slice(Math.max(0, matchIdx - 400), matchIdx + 400);
            const ctxText = ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
            const roleMatch = ctxText.match(/\b(CEO|CTO|COO|CFO|CPO|Founder|Co-?Founder|Head of [\w ]+|VP(?: of)? [\w ]+|Director of [\w ]+|Engineering Manager|Recruiter|Talent|HR)\b/i);
            if (roleMatch && !candidates.get(key)!.role) candidates.get(key)!.role = roleMatch[0];
          }

          const domainStr = domain;
          const allEmails = [...html.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)]
            .map(m => m[0]!.toLowerCase())
            .filter(e => e.includes(domainStr));

          for (const email of allEmails) {
            const prefix = email.split('@')[0]!.replace(/[._\-]/g, ' ').toLowerCase();
            let matched = false;
            for (const [key, cand] of candidates) {
              if (!cand.email && (key.startsWith(prefix) || prefix.startsWith(key.split(' ')[0]!))) {
                cand.email = email; matched = true; break;
              }
            }
            if (!matched) candidates.set(`__email_${email}`, { name: '', email });
          }

          const phones = [...new Set([...text.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\+\d{1,3}[-.\s]\d{2,4}[-.\s]\d{3,4}[-.\s]\d{3,4}/g)].map(m => m[0]!.trim()))].slice(0, 10);
          const techKeywords = ['react','vue','angular','node','nodejs','python','django','flask','fastapi',
            'ruby','rails','golang','go','java','spring','kotlin','swift','typescript','nextjs','nestjs',
            'aws','gcp','azure','docker','kubernetes','postgres','mongodb','redis','graphql','rust','elixir']
            .filter(kw => text.toLowerCase().includes(kw));

          const people = [...candidates.values()]
            .filter(p => p.name && p.name.length > 1)
            .map(p => ({ name: p.name, role: p.role ?? null, email: p.email ?? null, phone: p.phone ?? null, linkedin: p.linkedin ?? null }));

          return JSON.stringify({
            defunct: false, purpose,
            textLength:   text.length,
            people,
            emails:       [...new Set(allEmails)],
            phones,
            techKeywords: [...new Set(techKeywords)],
            excerpt:      text.slice(0, 600),
          });
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code ?? '';
          if (['ENOTFOUND', 'ECONNREFUSED'].includes(code)) return JSON.stringify({ defunct: true, reason: 'Domain unreachable' });
          return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
        } finally {
          if (context) await context.close().catch(() => {});
        }
      },
      {
        name:        'playwright_scrape_url',
        description: 'Use a stealth Playwright browser to scrape any URL. Use as fallback when APIs fail or return no data. Good for /careers, /team, /about, /jobs pages.',
        schema: z.object({
          url:     z.string().describe('Full URL to scrape'),
          purpose: z.string().describe('What you are looking for: "team_names", "tech_stack", "contact_emails", "company_info"'),
        }),
      },
    ),

    // ── save_contacts ─────────────────────────────────────────────────────────
    tool(
      async ({ companyId: cid, contacts }) => {
        const targetId = cid ?? companyId;
        const valid = contacts
          .filter(c => c.fullName && c.role)
          .map(c => ({ c, role: normalizeRole(c.role) as ContactRole }))
          .filter(({ role }) => role !== 'Unknown');

        await Promise.allSettled(
          valid.map(({ c, role }) =>
            contactRepository.upsert({
              companyId:   targetId,
              fullName:    c.fullName,
              firstName:   c.fullName.split(' ')[0],
              lastName:    c.fullName.split(' ').at(-1),
              role,
              email:       c.email,
              linkedinUrl: c.linkedinUrl,
              phone:       c.phone,
              sources:     ['agent'],
              forOriginRatio: false,
            }).catch(err => logger.debug({ err, domain }, '[enrichment.agent] save_contacts failed'))
          )
        );

        return JSON.stringify({ saved: valid.length, total: contacts.length });
      },
      {
        name:        'save_contacts',
        description: 'Save an array of decision-maker contacts (CEO, CTO, VP Engineering, HR, etc.) with full details. Only saves contacts with known roles.',
        schema: z.object({
          companyId: z.string(),
          contacts: z.array(z.object({
            fullName:    z.string(),
            role:        z.string().describe('CEO, CTO, VP of Engineering, Head of Engineering, Director of Engineering, HR, Recruiter, Founder, Co-Founder, COO, CPO, CFO, Head of Talent'),
            email:       z.string().optional(),
            linkedinUrl: z.string().optional(),
            phone:       z.string().optional(),
          })),
        }),
      },
    ),

    // ── compute_origin_ratio ──────────────────────────────────────────────────
    tool(
      async () => {
        const settings  = await settingsRepository.get();
        const allNames  = await contactRepository.findAllNamesForOriginRatio(companyId);
        const nameList  = allNames.filter(n => n.fullName);

        if (nameList.length < settings.originRatioMinSample) {
          return JSON.stringify({ computed: false, reason: `Insufficient names: ${nameList.length} < ${settings.originRatioMinSample} required` });
        }

        const result  = await indianRatioAnalyzer.analyzeNames(nameList);
        const company = await companyRepository.findById(companyId);

        await companyRepository.upsert({
          domain, name: company?.name ?? '',
          originDevCount:    result.indianCount,
          totalDevCount:     result.totalCount,
          originRatio:       result.ratio,
          toleranceIncluded: result.ratio < 0.75 && result.ratio >= settings.originRatioThreshold,
        });

        return JSON.stringify({
          computed:       true,
          ratio:          result.ratio,
          indianCount:    result.indianCount,
          totalCount:     result.totalCount,
          reliable:       result.reliable,
          meetsThreshold: result.ratio >= settings.originRatioThreshold,
        });
      },
      {
        name:        'compute_origin_ratio',
        description: 'Analyse all collected names to estimate the fraction of Indian-origin developers. Call after gathering names from GitHub, website, and Hunter.',
        schema: z.object({ companyId: z.string() }),
      },
    ),

    // ── save_company_data ─────────────────────────────────────────────────────
    tool(
      async (data) => {
        const company = await companyRepository.findById(companyId);
        await companyRepository.upsert({
          ...data,
          domain,
          name: data.name ?? company?.name ?? '',
        } as any);
        return JSON.stringify({ saved: true });
      },
      {
        name:        'save_company_data',
        description: 'Save/merge partial company data (tech stack, employee count, funding, etc.) to the database.',
        schema: z.object({
          domain:        z.string(),
          name:          z.string(),
          techStack:     z.array(z.string()).optional(),
          employeeCount: z.number().optional(),
          fundingStage:  z.string().optional(),
          hqCountry:     z.string().optional(),
          websiteUrl:    z.string().optional(),
          githubOrg:     z.string().optional(),
        }),
      },
    ),

    // ── disqualify_company ────────────────────────────────────────────────────
    tool(
      async ({ reason }) => {
        await companyRepository.disqualify(companyId);
        logger.info({ domain, reason }, '[enrichment.agent] Disqualified');
        return JSON.stringify({ disqualified: true, reason });
      },
      {
        name:        'disqualify_company',
        description: 'Mark the company as disqualified and stop enrichment. Use for: defunct websites, employee count > 1000, Indian HQ, no tech signal.',
        schema: z.object({
          companyId: z.string(),
          reason:    z.string(),
        }),
      },
    ),

    // ── queue_for_scoring ─────────────────────────────────────────────────────
    tool(
      async () => {
        await companyRepository.upsert({ domain, name: '', lastEnrichedAt: new Date(), pipelineStatus: 'enriched' } as any);
        await companyRepository.setPipelineStatus(companyId, 'scoring');
        await queueManager.addScoringJob({ runId, companyId });
        return JSON.stringify({ queued: true });
      },
      {
        name:        'queue_for_scoring',
        description: 'Send the company to the scoring queue. Call when enrichment is complete.',
        schema: z.object({
          companyId: z.string(),
          runId:     z.string(),
        }),
      },
    ),
  ];
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

  if (company.employeeCount && company.employeeCount > 1000) {
    await companyRepository.disqualify(companyId);
    return;
  }

  await companyRepository.setPipelineStatus(companyId, 'enriching');

  const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
  if (!force && company.lastEnrichedAt) {
    const ageMs = Date.now() - new Date(company.lastEnrichedAt).getTime();
    if (ageMs < COOLDOWN_MS) {
      logger.info({ domain, ageHours: (ageMs / 3_600_000).toFixed(1) }, '[enrichment.agent] Cooldown — queuing scoring only');
      await queueManager.addScoringJob({ runId, companyId });
      return;
    }
  }

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
    await runAgent({
      name:          `enrichment:${domain}`,
      systemPrompt:  SYSTEM_PROMPT,
      tools:         makeTools(job),
      userMessage,
      maxIterations: 18,
    });
    logger.info({ domain, durationMs: Date.now() - startedAt }, '[enrichment.agent] Complete');
  } catch (err) {
    logger.error({ err, domain }, '[enrichment.agent] Failed');
    await alertAgentFailure({ agent: `enrichment:${domain}`, runId, error: err });
    throw err;
  }
}
