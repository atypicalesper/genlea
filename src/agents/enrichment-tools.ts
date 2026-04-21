import { z }                          from 'zod';
import { tool }                        from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { companyRepository }           from '../storage/repositories/company.repository.js';
import { contactRepository }           from '../storage/repositories/contact.repository.js';
import { settingsRepository }          from '../storage/repositories/settings.repository.js';
import { queueManager }                from '../core/queue.manager.js';
import { browserManager }              from '../core/browser.manager.js';
import { proxyManager }                from '../core/proxy.manager.js';
import { indianRatioAnalyzer }         from '../enrichment/dev-origin.analyzer.js';
import { contactResolver }             from '../enrichment/contact.resolver.js';
import { websiteTeamScraper }          from '../enrichment/website-team.enricher.js';
import { normalizer, normalizeRole }   from '../enrichment/normalizer.js';
import { deduplicateContacts }         from '../enrichment/deduplicator.js';
import { extractPeopleFromPage }       from '../enrichment/page-content-extractor.js';
import { isDefunct }                   from '../enrichment/defunct-detector.js';
import { githubScraper, hunterScraper, clearbitScraper, exploriumScraper, clayScraper } from '../scrapers/enrichment/index.js';
import { logger }                      from '../utils/logger.js';
import type { EnrichmentJobData, ContactRole } from '../types/index.js';

export function makeTools(job: EnrichmentJobData): StructuredToolInterface[] {
  const { runId, companyId, domain } = job;

  return [
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
        description: 'ALWAYS call first. Returns existing data (tech stack, employee count, contacts, origin ratio) and a `missing` map of gaps. Use the missing flags to decide which enrichment tools to call — skip any source whose data is already present.',
        schema: z.object({ companyId: z.string() }),
      },
    ),

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
              }),
            ),
          );
          namesSaved = result.contacts.filter(c => c.fullName).length;
        }

        return JSON.stringify({ found: true, githubOrg: result.company.githubOrg, techStack: result.company.techStack ?? [], namesSaved });
      },
      {
        name:        'enrich_github',
        description: 'Search for the company GitHub org by domain, pull tech stack from public repos, and collect contributor names for origin ratio. Best free source of dev names — call before compute_origin_ratio. Returns `found: false` if no org matched. Results auto-saved.',
        schema: z.object({ domain: z.string() }),
      },
    ),

    tool(
      async ({ name: companyName }) => {
        const unavailableReason = exploriumScraper.getUnavailableReason();
        if (unavailableReason) {
          return JSON.stringify({ available: false, reason: unavailableReason });
        }
        const result = await exploriumScraper.enrichDomain(domain, companyName).catch(() => null);
        if (!result) {
          const reason = exploriumScraper.getUnavailableReason();
          if (reason) return JSON.stringify({ available: false, reason });
          return JSON.stringify({ found: false });
        }

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
              }).catch(err => logger.debug({ err, domain }, '[enrichment-tools] Explorium contact save failed')),
            ),
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
        description: 'Best single enrichment source — returns company metadata (tech stack, employee count, funding, HQ) AND decision-maker contacts (CEO/HR/CTO with email, phone, LinkedIn) in one call. Try this first after get_company_state. Returns `available: false` if EXPLORIUM_API_KEY is missing — skip it. Results auto-saved.',
        schema: z.object({
          domain: z.string(),
          name:   z.string().optional().describe('Company name (improves match accuracy)'),
        }),
      },
    ),

    tool(
      async ({ name: companyName }) => {
        if (!process.env['CLAY_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'CLAY_API_KEY not configured' });
        }
        const result = await clayScraper.enrichDomain(domain, companyName).catch(() => null);
        if (!result) return JSON.stringify({ found: false });

        const company = await companyRepository.findById(companyId);
        if (result.company) {
          await companyRepository.upsert({ ...result.company, domain, name: company?.name ?? '' });
        }

        let contactsSaved = 0;
        if (result.contacts?.length) {
          const valid = result.contacts.filter(c => c.fullName && c.role && c.role !== 'Unknown');
          await Promise.allSettled(
            valid.map(c =>
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
                sources:         ['clay'],
                forOriginRatio:  false,
              }).catch(err => logger.debug({ err, domain }, '[enrichment-tools] Clay contact save failed')),
            ),
          );
          contactsSaved = valid.length;
        }

        return JSON.stringify({
          found:         true,
          employeeCount: result.company?.employeeCount,
          fundingStage:  result.company?.fundingStage,
          techStack:     result.company?.techStack ?? [],
          contactsSaved,
          contacts: result.contacts?.map(c => ({ name: c.fullName, role: c.role, email: c.email, linkedin: c.linkedinUrl })),
        });
      },
      {
        name:        'enrich_clay',
        description: 'Alternative to Explorium — returns company metadata and decision-maker contacts. Use if Explorium is unavailable or returned no contacts. Returns `available: false` if CLAY_API_KEY is missing — skip it. Results auto-saved.',
        schema: z.object({
          domain: z.string(),
          name:   z.string().optional().describe('Company name (improves match accuracy)'),
        }),
      },
    ),

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
        description: 'Fetch firmographic data from Clearbit: employee count, funding stage, industry, HQ location. Does NOT return contacts — pair with enrich_hunter or scrape_website_team. Returns `available: false` if CLEARBIT_API_KEY is missing. Use only when Explorium/Clay are unavailable and employee count or funding stage is still missing.',
        schema: z.object({ domain: z.string() }),
      },
    ),

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
            }),
          ),
        );

        const decisionMakers = members
          .filter(p => p.role && normalizeRole(p.role) !== 'Unknown')
          .map(p => ({ name: p.fullName, role: p.role, email: p.email ?? null, phone: p.phone ?? null, linkedin: p.linkedinUrl ?? null }));

        return JSON.stringify({ found: true, count: members.length, names: members.map(m => m.fullName), decisionMakers });
      },
      {
        name:        'scrape_website_team',
        description: 'Scrape the company /team, /about, or /people pages for employee names and roles. Use when APIs return no contacts OR you need more names for origin ratio. Pass `websiteUrl` from company state if known; falls back to https://domain. Good source of CEO/CTO names even without emails. Results auto-saved.',
        schema: z.object({
          websiteUrl: z.string().optional().describe('Full URL e.g. https://acme.com'),
          domain:     z.string(),
        }),
      },
    ),

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
            }).catch(err => logger.debug({ err, domain }, '[enrichment-tools] Hunter contact save failed')),
          ),
        );

        return JSON.stringify({ found: true, contactsFound: result.contacts.length, savedDecisionMakers: validDeduped.length });
      },
      {
        name:        'enrich_hunter',
        description: 'Find professional email addresses for a domain via Hunter.io. Best used as a gap-filler after Explorium/Clay — adds emails to contacts that came back without them. Returns `available: false` if HUNTER_API_KEY is missing. Only saves contacts with identifiable roles (CEO, HR, etc.).',
        schema: z.object({ domain: z.string() }),
      },
    ),

    tool(
      async () => {
        if (!process.env['HUNTER_API_KEY'] && !process.env['SMTP_HOST']) {
          return JSON.stringify({ available: false, reason: 'No HUNTER_API_KEY or SMTP_HOST configured — skipping contact verification' });
        }
        await contactResolver.resolveForCompany(companyId, domain).catch(err =>
          logger.warn({ err, domain }, '[enrichment-tools] Contact resolution failed — continuing'),
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
        description: 'SMTP-verify email deliverability for all saved contacts and synthesise missing CEO/HR/CTO emails using common patterns (first@domain, first.last@domain). Call after all contact-gathering tools are done. Returns `available: false` if neither HUNTER_API_KEY nor SMTP_HOST is configured — skip it.',
        schema: z.object({
          companyId: z.string(),
          domain:    z.string(),
        }),
      },
    ),

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

          if (isDefunct(html, text)) {
            return JSON.stringify({ defunct: true, reason: 'Shutdown/parked signals detected' });
          }

          const { people, emails, phones, techKeywords } = extractPeopleFromPage(html, text, domain);

          return JSON.stringify({
            defunct: false, purpose,
            textLength:   text.length,
            people:       people.map(p => ({ name: p.name, role: p.role ?? null, email: p.email ?? null, phone: p.phone ?? null, linkedin: p.linkedin ?? null })),
            emails,
            phones,
            techKeywords,
            excerpt:      text.slice(0, 600),
          });
        } catch (err) {
          const code  = (err as NodeJS.ErrnoException).code ?? '';
          const msg   = err instanceof Error ? err.message : String(err);
          const cause = (err as { cause?: unknown })?.cause ? String((err as { cause?: unknown }).cause) : undefined;
          if (['ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
            logger.warn({ url, domain, code }, '[enrichment-tools] playwright_scrape_url — domain unreachable');
            return JSON.stringify({ defunct: true, reason: `Domain unreachable (${code})` });
          }
          logger.warn({ url, domain, error: msg, cause, code }, '[enrichment-tools] playwright_scrape_url failed');
          return JSON.stringify({ error: msg, cause, code });
        } finally {
          if (context) await context.close().catch(() => {});
        }
      },
      {
        name:        'playwright_scrape_url',
        description: 'Last-resort scraper using a stealth Playwright browser. Use when: (a) all APIs returned no data, (b) you need to verify the company is still active, or (c) scraping /careers or /jobs for tech stack signals. Set `purpose` to guide extraction: "team_names" → people+roles, "tech_stack" → frameworks/tools, "contact_emails" → emails, "company_info" → general metadata. Returns `defunct: true` if the site shows shutdown signals — disqualify the company if so.',
        schema: z.object({
          url:     z.string().describe('Full URL to scrape'),
          purpose: z.string().describe('What you are looking for: "team_names", "tech_stack", "contact_emails", "company_info"'),
        }),
      },
    ),

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
            }).catch(err => logger.debug({ err, domain }, '[enrichment-tools] save_contacts failed')),
          ),
        );

        return JSON.stringify({ saved: valid.length, total: contacts.length });
      },
      {
        name:        'save_contacts',
        description: 'Persist contacts extracted manually from playwright_scrape_url results. Only call this when playwright returned people data that has NOT been auto-saved — Explorium, Clay, GitHub, Hunter, and scrape_website_team all auto-save their own contacts. Skips any entry with an unrecognised role.',
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
        description: 'Estimate the Indian-origin developer ratio from all collected names. Call only after enrich_github, scrape_website_team, and enrich_hunter have all been attempted. Requires at least originRatioMinSample names (check `totalNamesCollected` in get_company_state). Returns `computed: false` if too few names — do not retry, just proceed to queue_for_scoring.',
        schema: z.object({ companyId: z.string() }),
      },
    ),

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
        description: 'Merge partial company data into the database. Use when playwright_scrape_url or manual parsing yields structured fields (tech stack, employee count, funding) that were not auto-saved by the enrichment tools. All fields are optional — only pass what was actually found.',
        schema: z.object({
          domain:        z.string(),
          name:          z.string(),
          techStack:     z.array(z.string()).optional(),
          employeeCount: z.number().optional(),
          fundingStage:  z.string().optional(),
          fundingTotalUsd: z.number().optional(),
          foundedYear:   z.number().int().optional(),
          hqCountry:     z.string().optional(),
          websiteUrl:    z.string().optional(),
          githubOrg:     z.string().optional(),
        }),
      },
    ),

    tool(
      async ({ reason }) => {
        await companyRepository.disqualify(companyId, reason);
        logger.info({ domain, reason }, '[enrichment-tools] Disqualified');
        return JSON.stringify({ disqualified: true, reason });
      },
      {
        name:        'disqualify_company',
        description: 'Permanently mark the company as disqualified and halt enrichment. Triggers: playwright returned `defunct: true`, employeeCount > 1000, hqCountry is India, or zero tech signals after all sources exhausted. After calling this do NOT call queue_for_scoring — the pipeline ends here.',
        schema: z.object({
          companyId: z.string(),
          reason:    z.string(),
        }),
      },
    ),

    tool(
      async () => {
        await companyRepository.upsert({ domain, name: '', lastEnrichedAt: new Date(), pipelineStatus: 'enriched' } as any);
        await companyRepository.setPipelineStatus(companyId, 'scoring');
        await queueManager.addScoringJob({ runId, companyId });
        return JSON.stringify({ queued: true });
      },
      {
        name:        'queue_for_scoring',
        description: 'FINAL step — signals enrichment is complete and enqueues scoring. Call only after all relevant enrichment tools have run and any manual saves are flushed. Do NOT call if disqualify_company was called. Marks pipelineStatus as "scoring".',
        schema: z.object({
          companyId: z.string(),
          runId:     z.string(),
        }),
      },
    ),
  ];
}
