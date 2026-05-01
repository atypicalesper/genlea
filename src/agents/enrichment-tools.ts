import { z }                          from 'zod';
import { tool }                        from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { companyRepository }           from '../storage/repositories/company.repository.js';
import { contactRepository }           from '../storage/repositories/contact.repository.js';
import { jobRepository }               from '../storage/repositories/job.repository.js';
import { settingsRepository }          from '../storage/repositories/settings.repository.js';
import { queueManager }                from '../core/queue.manager.js';
import { browserManager }              from '../core/browser.manager.js';
import { proxyManager }                from '../core/proxy.manager.js';
import { normalizeDomain }             from '../utils/random.js';
import { indianRatioAnalyzer }         from '../enrichment/dev-origin.analyzer.js';
import { contactResolver }             from '../enrichment/contact.resolver.js';
import { websiteTeamScraper }          from '../enrichment/website-team.enricher.js';
import { normalizer, normalizeRole }   from '../enrichment/normalizer.js';
import { deduplicateContacts }         from '../enrichment/deduplicator.js';
import { extractPeopleFromPage }       from '../enrichment/page-content-extractor.js';
import { isDefunct }                   from '../enrichment/defunct-detector.js';
import { githubScraper, hunterScraper } from '../scrapers/enrichment/index.js';
import {
  linkedInScraper,
  wellfoundScraper,
  indeedScraper,
  glassdoorScraper,
  surelyRemoteScraper,
} from '../scrapers/discovery/index.js';
import { capOutput }                    from './tool-utils.js';
import { logger }                      from '../utils/logger.js';
import type { EnrichmentJobData, ContactRole } from '../types/index.js';

export function makeTools(job: EnrichmentJobData): StructuredToolInterface[] {
  const { runId, companyId, domain, correlationId } = job;
  const hiringScrapers = {
    linkedin: linkedInScraper,
    wellfound: wellfoundScraper,
    indeed: indeedScraper,
    glassdoor: glassdoorScraper,
    surelyremote: surelyRemoteScraper,
  } as const;
  const defaultHiringSources = Object.keys(hiringScrapers) as Array<keyof typeof hiringScrapers>;

  const tools = [
    tool(
      async () => {
        const [company, contacts, allNames, activeJobs] = await Promise.all([
          companyRepository.findById(companyId),
          contactRepository.findByCompanyId(companyId),
          contactRepository.findAllNamesForOriginRatio(companyId),
          jobRepository.findByCompanyId(companyId, true),
        ]);
        const nameCount = allNames.length;
        if (!company) return JSON.stringify({ error: 'Company not found' });
        return JSON.stringify({
          name:          company.name,
          domain:        company.domain,
          websiteUrl:    company.websiteUrl,
          employeeCount: company.employeeCount,
          hqCountry:     company.hqCountry,
          fundingStage:  company.fundingStage,
          techStack:     company.techStack ?? [],
          activeJobsCount: activeJobs.length,
          openRoles: company.openRoles ?? [],
          originRatio:   company.originRatio,
          totalNamesCollected: nameCount,
          contacts: contacts.map(c => ({ role: c.role, fullName: c.fullName, hasEmail: !!c.email, emailVerified: c.emailVerified })),
          status:        company.status,
          lastEnrichedAt: company.lastEnrichedAt,
          missing: {
            techStack:    (company.techStack?.length ?? 0) === 0,
            employeeCount: !company.employeeCount,
            contacts:     contacts.length === 0,
            hiring:       activeJobs.length === 0,
            originRatio:  !company.originRatio,
            names:        nameCount < 5,
          },
        });
      },
      {
        name:        'get_company_state',
        description: 'Get the current company state. Call this first.',
        schema: z.object({}),
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
        description: 'Find the GitHub org, extract tech stack, and collect contributor names.',
        schema: z.object({}),
      },
    ),

    tool(
      async ({ websiteUrl: url }) => {
        const targetUrl = url || `https://${domain}`;
        const members = await websiteTeamScraper.scrapeTeam(targetUrl, domain).catch(() => []);
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
        description: 'Scrape team/about/people pages for names and roles.',
        schema: z.object({
          websiteUrl: z.string().optional().describe('Full URL e.g. https://acme.com'),
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
        console.info('This is the result of the hunter scraper: ', result) //do not remove this console.info
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
        description: 'Find emails and contacts for the company domain via Hunter.',
        schema: z.object({}),
      },
    ),

    tool(
      async ({ sources }) => {
        const company = await companyRepository.findById(companyId);
        if (!company) return JSON.stringify({ error: 'Company not found' });

        const selectedSources = (sources?.length ? sources : defaultHiringSources)
          .filter(source => source in hiringScrapers) as Array<keyof typeof hiringScrapers>;

        const checkedSources: string[] = [];
        const matchedSources: Array<{ source: string; jobsFound: number }> = [];
        let persistedJobs = 0;

        for (const source of selectedSources) {
          const scraper = hiringScrapers[source];
          if (!(await scraper.isAvailable().catch(() => false))) continue;
          checkedSources.push(source);

          try {
            const hiringLocation = company.hqCountry && company.hqCountry !== 'Unknown' && company.hqCountry.toLowerCase() !== 'india'
              ? company.hqCountry
              : 'Remote';
            const rawResults = await scraper.scrape({
              keywords: `${company.name} software engineer`,
              location: hiringLocation,
              limit: 10,
            });

            const matchedJobs = rawResults
              .filter(result => matchesCompany(result.company?.name, result.company?.domain, company.name, domain))
              .flatMap(result => result.jobs ?? [])
              .filter(job => job.title);

            if (!matchedJobs.length) continue;

            matchedSources.push({ source, jobsFound: matchedJobs.length });

            const settled = await Promise.allSettled(
              matchedJobs.map(job =>
                jobRepository.upsert({
                  companyId,
                  title: job.title!.trim(),
                  techTags: job.techTags ?? [],
                  source: job.source ?? source,
                  sourceUrl: job.sourceUrl,
                  postedAt: job.postedAt,
                  isActive: true,
                }),
              ),
            );
            persistedJobs += settled.filter(r => r.status === 'fulfilled').length;
          } catch (err) {
            logger.debug({ err, source, domain }, '[enrichment-tools] Hiring check failed');
          }
        }

        return JSON.stringify({
          checkedSources,
          matchedSources,
          jobsFound: matchedSources.reduce((sum, item) => sum + item.jobsFound, 0),
          persistedJobs,
          hiringDetected: persistedJobs > 0,
        });
      },
      {
        name:        'check_company_hiring',
        description: 'Check LinkedIn and other hiring sources for active engineering jobs for this company and persist any jobs found.',
        schema: z.object({
          sources: z.array(z.enum(['linkedin', 'wellfound', 'indeed', 'glassdoor', 'surelyremote'])).optional(),
        }),
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
        description: 'Verify saved contacts and fill obvious email gaps.',
        schema: z.object({}),
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
          if (context) await context.close().catch(err => logger.warn({ err, url, domain }, '[enrichment-tools] Browser context close failed'));
        }
      },
      {
        name:        'playwright_scrape_url',
        description: 'Stealth Playwright scraper for team, jobs, contact, or company pages.',
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
        description: 'Persist manually extracted contacts that were not auto-saved.',
        schema: z.object({
          companyId: z.string().optional(),
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
        description: 'Estimate the Indian-origin ratio from collected names.',
        schema: z.object({}),
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
        description: 'Merge partial company data into the database.',
        schema: z.object({
          domain:        z.string().optional(),
          name:          z.string().optional(),
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
        description: 'Mark the company as disqualified and stop enrichment.',
        schema: z.object({
          reason:    z.string(),
        }),
      },
    ),

    tool(
      async () => {
        const company = await companyRepository.findById(companyId);
        if (company?.status === 'disqualified' && company.manuallyReviewed) {
          await companyRepository.setPipelineStatus(companyId, 'scored');
          return JSON.stringify({ queued: false, cancelled: true, reason: 'Company was manually disqualified' });
        }

        await companyRepository.setLastEnrichedAt(companyId);
        await companyRepository.setPipelineStatus(companyId, 'scoring');
        await queueManager.addScoringJob({ runId, companyId, correlationId });
        return JSON.stringify({ queued: true });
      },
      {
        name:        'queue_for_scoring',
        description: 'Final step: mark enrichment complete and enqueue scoring.',
        schema: z.object({}),
      },
    ),
  ];

  // Cap the three tools whose outputs grow with team/contact size.
  const CAPS: Record<string, number> = {
    scrape_website_team:  600,
    check_company_hiring: 600,
    verify_contacts:      600,
    playwright_scrape_url: 800,
  };
  return tools.map(t => t.name in CAPS ? capOutput(t, CAPS[t.name]!) : t);
}

function normalizeCompanyMatchValue(value?: string): string {
  return (value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function matchesCompany(foundName: string | undefined, foundDomain: string | undefined, targetName: string, targetDomain: string): boolean {
  const normalizedTargetDomain = normalizeDomain(targetDomain);
  const normalizedFoundDomain = normalizeDomain(foundDomain ?? '');
  if (normalizedTargetDomain && normalizedFoundDomain && normalizedTargetDomain === normalizedFoundDomain) {
    return true;
  }

  const found = normalizeCompanyMatchValue(foundName);
  const target = normalizeCompanyMatchValue(targetName);
  return !!found && !!target && (found === target || found.includes(target) || target.includes(found));
}
