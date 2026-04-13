import { z }                          from 'zod';
import { tool }                        from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import {
  companyRepository, contactRepository, settingsRepository,
  queueManager, browserManager, proxyManager,
  normalizer, normalizeRole, deduplicateContacts,
  logger,
} from '@genlea/shared';
import type { EnrichmentJobData, ContactRole } from '@genlea/shared';
import { indianRatioAnalyzer }         from '../enrichment/dev-origin.analyzer.js';
import { contactResolver }             from '../enrichment/contact.resolver.js';
import { websiteTeamScraper }          from '../enrichment/website-team.enricher.js';
import { extractPeopleFromPage }       from '../enrichment/page-content-extractor.js';
import { isDefunct }                   from '../enrichment/defunct-detector.js';
import {
  githubScraper, hunterScraper, clearbitScraper, exploriumScraper, clayScraper,
} from '../scrapers/index.js';

export function makeTools(job: EnrichmentJobData): StructuredToolInterface[] {
  const { runId, companyId, domain } = job;

  // ── Per-job dedup: prevent re-calling expensive API sources ─────────────────
  // Tools in this set can only be called once per enrichment job.
  const calledOnce = new Set<string>();
  // URLs already scraped by playwright
  const scrapedUrls = new Set<string>();

  function onceGuard(toolName: string): string | null {
    if (calledOnce.has(toolName)) {
      return JSON.stringify({
        error: `${toolName} already called for this company — call check_enrichment_progress to see what's still missing and choose a different source`,
        alreadyCalled: true,
      });
    }
    calledOnce.add(toolName);
    return null;
  }

  return [

    // ── 0. Get current state ──────────────────────────────────────────────────
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
            techStack:     (company.techStack?.length ?? 0) < 2,
            employeeCount: !company.employeeCount,
            contacts:      contacts.length === 0,
            originRatio:   !company.originRatio,
            names:         nameCount < 5,
          },
        });
      },
      {
        name:        'get_company_state',
        description: 'Get current state of the company from the database. Call this first to understand the starting point.',
        schema: z.object({}),
      },
    ),

    // ── 1. Enrichment progress / goal check ───────────────────────────────────
    tool(
      async () => {
        const settings  = await settingsRepository.get();
        const company   = await companyRepository.findById(companyId);
        const contacts  = await contactRepository.findByCompanyId(companyId);
        const names     = await contactRepository.findAllNamesForOriginRatio(companyId);

        const techFilled  = (company?.techStack?.length ?? 0) >= 2;
        const namesMet    = names.length >= settings.originRatioMinSample;
        const dmRoles: ContactRole[] = ['CEO', 'Founder', 'Co-Founder', 'CTO', 'VP of Engineering', 'Head of Engineering', 'HR', 'Recruiter', 'Head of Talent'];
        const decisionMakers = contacts.filter(c => dmRoles.includes(c.role as ContactRole));
        const hasContact  = decisionMakers.length >= 1;
        const hasEmail    = decisionMakers.some(c => c.email);
        const ratioComputed = company?.originRatio != null;

        const goalMet = techFilled && namesMet && hasContact;

        let nextBestAction: string;
        if (!techFilled) {
          nextBestAction = 'enrich_github — free, provides tech stack + dev names';
        } else if (!namesMet) {
          nextBestAction = `scrape_website_team or playwright_scrape_url on https://${domain}/team — need ${settings.originRatioMinSample - names.length} more names`;
        } else if (!hasContact) {
          const hasExplorium = !!process.env['EXPLORIUM_API_KEY'];
          const hasHunter    = !!process.env['HUNTER_API_KEY'];
          const hasClay      = !!process.env['CLAY_API_KEY'];
          if (hasExplorium && !calledOnce.has('enrich_explorium'))      nextBestAction = 'enrich_explorium — returns verified contacts';
          else if (hasClay && !calledOnce.has('enrich_clay'))           nextBestAction = 'enrich_clay — returns contacts with emails';
          else if (hasHunter && !calledOnce.has('enrich_hunter'))       nextBestAction = 'enrich_hunter — email discovery';
          else nextBestAction = `playwright_scrape_url on https://${domain}/team or /about`;
        } else if (!hasEmail) {
          nextBestAction = 'verify_contacts — SMTP verify + fill email gaps';
        } else if (!ratioComputed && namesMet) {
          nextBestAction = 'compute_origin_ratio — enough names collected';
        } else {
          nextBestAction = 'queue_for_scoring — goal is met';
        }

        return JSON.stringify({
          techStackFilled:     techFilled,
          techStackCount:      company?.techStack?.length ?? 0,
          nameCount:           names.length,
          nameGoal:            settings.originRatioMinSample,
          namesMet,
          decisionMakerCount:  decisionMakers.length,
          hasDecisionMaker:    hasContact,
          hasVerifiedEmail:    hasEmail,
          originRatioComputed: ratioComputed,
          goalMet,
          nextBestAction,
          summary: `Tech:${techFilled ? '✓' : '✗'} | Names:${names.length}/${settings.originRatioMinSample} | DM:${decisionMakers.length} | Email:${hasEmail ? '✓' : '✗'}`,
        });
      },
      {
        name:        'check_enrichment_progress',
        description: 'Check enrichment progress and get the recommended next action. Call this after each enrichment step to decide what to do next. When goalMet: true, call compute_origin_ratio (if not done) then queue_for_scoring.',
        schema: z.object({}),
      },
    ),

    // ── 2. GitHub ─────────────────────────────────────────────────────────────
    tool(
      async () => {
        const guard = onceGuard('enrich_github');
        if (guard) return guard;

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
        description: 'Find company GitHub org, extract tech stack from repos, collect contributor names for origin ratio. Free, no API key. Always try this first.',
        schema: z.object({}),
      },
    ),

    // ── 3. Explorium ──────────────────────────────────────────────────────────
    tool(
      async ({ name: companyName }) => {
        if (!process.env['EXPLORIUM_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'EXPLORIUM_API_KEY not configured' });
        }
        const guard = onceGuard('enrich_explorium');
        if (guard) return guard;

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
        description: 'Fetch company metadata AND decision-maker contacts from Explorium (requires EXPLORIUM_API_KEY). Best single source — returns verified contacts with email/phone/LinkedIn.',
        schema: z.object({
          name: z.string().optional().describe('Company name (improves match accuracy)'),
        }),
      },
    ),

    // ── 4. Clay ───────────────────────────────────────────────────────────────
    tool(
      async ({ name: companyName }) => {
        if (!process.env['CLAY_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'CLAY_API_KEY not configured' });
        }
        const guard = onceGuard('enrich_clay');
        if (guard) return guard;

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
        description: 'Fetch company metadata and decision-maker contacts from Clay (requires CLAY_API_KEY). Use after Explorium or as standalone.',
        schema: z.object({
          name: z.string().optional().describe('Company name (improves match accuracy)'),
        }),
      },
    ),

    // ── 5. Clearbit ───────────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['CLEARBIT_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'CLEARBIT_API_KEY not configured — use playwright_scrape_url on the company homepage instead' });
        }
        const guard = onceGuard('enrich_clearbit');
        if (guard) return guard;

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
        description: 'Fetch company metadata from Clearbit — employee count, funding stage, industry, location. Skip if Explorium or Clay already provided metadata.',
        schema: z.object({}),
      },
    ),

    // ── 6. Website team scraper ───────────────────────────────────────────────
    tool(
      async ({ websiteUrl }) => {
        const guard = onceGuard('scrape_website_team');
        if (guard) return guard;

        const targetUrl = websiteUrl || `https://${domain}`;
        const members   = await websiteTeamScraper.scrapeTeam(targetUrl, domain).catch(() => []);
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
        description: 'Scrape company /team /about /people pages for team member names and emails. Free, no API key needed.',
        schema: z.object({
          websiteUrl: z.string().optional().describe('Full URL e.g. https://acme.com — defaults to company domain'),
        }),
      },
    ),

    // ── 7. Hunter ─────────────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['HUNTER_API_KEY']) {
          return JSON.stringify({ available: false, reason: 'HUNTER_API_KEY not configured — use playwright_scrape_url on /team or /contact pages instead' });
        }
        const guard = onceGuard('enrich_hunter');
        if (guard) return guard;

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
        description: 'Discover emails and contacts for the domain using Hunter.io (requires HUNTER_API_KEY). Use when contacts are missing and Explorium/Clay are unavailable.',
        schema: z.object({}),
      },
    ),

    // ── 8. Verify contacts ────────────────────────────────────────────────────
    tool(
      async () => {
        if (!process.env['HUNTER_API_KEY'] && !process.env['SMTP_HOST']) {
          return JSON.stringify({ available: false, reason: 'No HUNTER_API_KEY or SMTP_HOST configured — skipping verification' });
        }
        const guard = onceGuard('verify_contacts');
        if (guard) return guard;

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
        description: 'SMTP-verify existing contacts and fill missing CEO/HR/CTO emails. Call after contacts have been gathered.',
        schema: z.object({}),
      },
    ),

    // ── 9. Playwright stealth scrape — auto-saves people found ────────────────
    tool(
      async ({ url, purpose }) => {
        if (scrapedUrls.has(url)) {
          return JSON.stringify({ error: `Already scraped ${url} — try a different URL`, alreadyScraped: true });
        }
        scrapedUrls.add(url);

        const browserId = `agent-${companyId.slice(-8)}`;
        let context: Awaited<ReturnType<typeof browserManager.createContext>> | null = null;
        try {
          const proxy = proxyManager.getProxy();
          context = await browserManager.createContext(browserId, { proxy });
          const page  = await browserManager.newPage(context);

          await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await browserManager.humanDelay(1000, 3000);

          const text = await page.innerText('body').catch(() => '');
          const html = await page.content();

          if (isDefunct(html, text)) {
            return JSON.stringify({ defunct: true, reason: 'Shutdown/parked signals detected' });
          }

          const { people, emails, phones, techKeywords } = extractPeopleFromPage(html, text, domain);

          // Auto-save: persist people found immediately — no separate save_contacts call needed
          let autoSaved = 0;
          if (people.length > 0) {
            const results = await Promise.allSettled(
              people
                .filter(p => p.name)
                .map(p => {
                  const role = normalizeRole(p.role ?? '') as ContactRole;
                  return contactRepository.upsert({
                    companyId,
                    fullName:       p.name,
                    firstName:      p.name.split(' ')[0],
                    lastName:       p.name.split(' ').at(-1),
                    role,
                    email:          p.email ?? undefined,
                    phone:          p.phone ?? undefined,
                    linkedinUrl:    p.linkedin ?? undefined,
                    sources:        ['website'],
                    forOriginRatio: true,
                  });
                }),
            );
            autoSaved = results.filter(r => r.status === 'fulfilled').length;
          }

          return JSON.stringify({
            defunct:      false,
            purpose,
            textLength:   text.length,
            peopleFound:  people.length,
            autoSaved,
            people:       people.map(p => ({ name: p.name, role: p.role ?? null, email: p.email ?? null, phone: p.phone ?? null, linkedin: p.linkedin ?? null })),
            emails,
            phones,
            techKeywords,
            excerpt:      text.slice(0, 400),
          });
        } catch (err) {
          const code  = (err as NodeJS.ErrnoException).code ?? '';
          const msg   = err instanceof Error ? err.message : String(err);
          const cause = (err as { cause?: unknown })?.cause ? String((err as { cause?: unknown }).cause) : undefined;
          if (['ENOTFOUND', 'ECONNREFUSED'].includes(code)) {
            logger.warn({ url, domain, code }, '[enrichment-tools] playwright — domain unreachable');
            return JSON.stringify({ defunct: true, reason: `Domain unreachable (${code})` });
          }
          logger.warn({ url, domain, error: msg, cause, code }, '[enrichment-tools] playwright failed');
          return JSON.stringify({ error: msg, cause, code });
        } finally {
          if (context) await context.close().catch(() => {});
        }
      },
      {
        name:        'playwright_scrape_url',
        description: 'Stealth Playwright browser to scrape any URL. People found are auto-saved to the database. Use for /careers, /team, /about, /jobs, /contact pages. Each URL can only be scraped once.',
        schema: z.object({
          url:     z.string().describe('Full URL to scrape'),
          purpose: z.string().describe('What you are looking for: "team_names", "tech_stack", "contact_emails", "company_info"'),
        }),
      },
    ),

    // ── 10. Save contacts (explicit, for LLM-extracted data) ─────────────────
    tool(
      async ({ contacts }) => {
        const valid = contacts
          .filter(c => c.fullName && c.role)
          .map(c => ({ c, role: normalizeRole(c.role) as ContactRole }))
          .filter(({ role }) => role !== 'Unknown');

        await Promise.allSettled(
          valid.map(({ c, role }) =>
            contactRepository.upsert({
              companyId,
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
        description: 'Explicitly save decision-maker contacts you have extracted from page content or other sources. Note: playwright_scrape_url auto-saves people it finds — only use this for additional contacts.',
        schema: z.object({
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

    // ── 11. Compute origin ratio ──────────────────────────────────────────────
    tool(
      async () => {
        const guard = onceGuard('compute_origin_ratio');
        if (guard) return guard;

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
        description: 'Analyse all collected names to estimate the Indian-origin developer fraction. Call after gathering ≥5 names. Only needs to be called once.',
        schema: z.object({}),
      },
    ),

    // ── 12. Save partial company data ─────────────────────────────────────────
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
        description: 'Save/merge partial company data (tech stack, employee count, funding, etc.) to the database. Use to persist data found via playwright or other sources.',
        schema: z.object({
          name:          z.string().optional(),
          techStack:     z.array(z.string()).optional(),
          employeeCount: z.number().optional(),
          fundingStage:  z.string().optional(),
          hqCountry:     z.string().optional(),
          websiteUrl:    z.string().optional(),
          githubOrg:     z.string().optional(),
        }),
      },
    ),

    // ── 13. Disqualify ────────────────────────────────────────────────────────
    tool(
      async ({ reason }) => {
        await companyRepository.disqualify(companyId);
        logger.info({ domain, reason }, '[enrichment-tools] Disqualified');
        return JSON.stringify({ disqualified: true, reason });
      },
      {
        name:        'disqualify_company',
        description: 'Mark as disqualified and stop. Use for: defunct website, employee count > 1000, Indian HQ, no tech signal after trying all sources.',
        schema: z.object({
          reason: z.string(),
        }),
      },
    ),

    // ── 14. Queue for scoring ─────────────────────────────────────────────────
    tool(
      async () => {
        await companyRepository.setPipelineStatus(companyId, 'scoring', new Date());
        await queueManager.addScoringJob({ runId, companyId });
        return JSON.stringify({ queued: true });
      },
      {
        name:        'queue_for_scoring',
        description: 'Send the company to the scoring queue. Call only when check_enrichment_progress returns goalMet: true (or after best effort when no more sources are available).',
        schema: z.object({}),
      },
    ),
  ];
}
