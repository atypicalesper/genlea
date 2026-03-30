#!/usr/bin/env tsx
import 'dotenv-flow/config';
import { Command } from 'commander';
import { connectMongo } from './storage/mongo.client.js';
import { queueManager } from './core/queue.manager.js';
import { companyRepository } from './storage/repositories/company.repository.js';
import { contactRepository } from './storage/repositories/contact.repository.js';
import { generateRunId } from './utils/random.js';
import { logger } from './utils/logger.js';
import { ScraperSource, ScrapeQuery } from './types/index.js';

const program = new Command();

program
  .name('genlea')
  .description('B2B Lead Generation Engine CLI')
  .version('0.1.0');

// ── scrape ────────────────────────────────────────────────────────────────────
program
  .command('scrape')
  .description('Trigger a scrape job')
  .requiredOption('-s, --source <source>', 'Scraper source: linkedin|wellfound|crunchbase|apollo|zoominfo')
  .requiredOption('-q, --query <query>', 'Search keywords')
  .option('-l, --limit <n>', 'Max companies to scrape', '25')
  .option('--tech <tags>', 'Comma-separated tech tags (e.g. nodejs,react)')
  .action(async (opts) => {
    await connectMongo();
    const runId = generateRunId();
    const source = opts.source as ScraperSource;
    const query: ScrapeQuery = {
      keywords:  opts.query,
      location:  'United States',
      limit:     parseInt(opts.limit),
      techStack: opts.tech ? opts.tech.split(',').map((t: string) => t.trim()) : undefined,
    };

    logger.info({ runId, source, query }, '[cli:scrape] Queuing discovery job');
    await queueManager.addDiscoveryJob({ runId, source, query });
    logger.info({ runId }, '[cli:scrape] ✅ Discovery job queued — start workers to process it');
    await queueManager.closeAll();
    process.exit(0);
  });

// ── score ─────────────────────────────────────────────────────────────────────
program
  .command('score')
  .description('Re-score all companies')
  .option('--filter <status>', 'Only re-score companies with this status')
  .action(async (opts) => {
    await connectMongo();
    const filter = opts.filter ? { status: opts.filter } : {};
    const companies = await companyRepository.findMany(filter, { limit: 10000 });
    logger.info({ total: companies.length }, '[cli:score] Re-scoring companies');

    let count = 0;
    const runId = generateRunId();
    for (const co of companies) {
      if (!co._id) continue;
      await queueManager.addScoringJob({ runId, companyId: co._id });
      count++;
    }

    logger.info({ count, runId }, '[cli:score] ✅ Scoring jobs queued');
    await queueManager.closeAll();
    process.exit(0);
  });

// ── stats ─────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show lead stats summary')
  .action(async () => {
    await connectMongo();
    const [total, hot, hotVerified, warm, cold] = await Promise.all([
      companyRepository.count(),
      companyRepository.count({ status: 'hot' }),
      companyRepository.count({ status: 'hot_verified' }),
      companyRepository.count({ status: 'warm' }),
      companyRepository.count({ status: 'cold' }),
    ]);
    console.table({ total, hot_verified: hotVerified, hot, warm, cold });
    await queueManager.closeAll();
    process.exit(0);
  });

// ── export ────────────────────────────────────────────────────────────────────
program
  .command('export')
  .description('Export leads to CSV')
  .option('--status <status>', 'Lead status filter', 'hot')
  .option('--min-score <n>', 'Minimum score', '65')
  .option('-o, --out <path>', 'Output CSV file path', 'exports/leads-export.csv')
  .action(async (opts) => {
    const { stringify } = await import('csv-stringify/sync');
    const { writeFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');

    await connectMongo();
    const companies = await companyRepository.findMany(
      { status: opts.status, score: { $gte: parseInt(opts.minScore) } },
      { sort: { score: -1 }, limit: 10000 }
    );

    logger.info({ count: companies.length, status: opts.status }, '[cli:export] Exporting leads');

    const rows = await Promise.all(companies.map(async co => {
      const contacts = co._id ? await contactRepository.findByCompanyId(co._id) : [];
      const ceo = contacts.find(c => ['CEO', 'Founder'].includes(c.role));
      const hr  = contacts.find(c => ['HR', 'Recruiter', 'Head of Talent'].includes(c.role));
      return {
        Company:          co.name,
        Domain:           co.domain,
        Score:            co.score,
        Status:           co.status,
        'Origin Ratio':   co.originRatio?.toFixed(2) ?? '',
        'Employee Count': co.employeeCount ?? '',
        'Tech Stack':     co.techStack.join(', '),
        'Funding Stage':  co.fundingStage ?? '',
        State:            co.hqState ?? '',
        LinkedIn:         co.linkedinUrl ?? '',
        'CEO Name':       ceo?.fullName ?? '',
        'CEO Email':      ceo?.email ?? '',
        'CEO Phone':      ceo?.phone ?? '',
        'CEO LinkedIn':   ceo?.linkedinUrl ?? '',
        'HR Name':        hr?.fullName ?? '',
        'HR Email':       hr?.email ?? '',
        'HR Phone':       hr?.phone ?? '',
      };
    }));

    const csv = stringify(rows, { header: true });
    await mkdir(dirname(opts.out), { recursive: true });
    await writeFile(opts.out, csv);
    logger.info({ file: opts.out, rows: rows.length }, '[cli:export] ✅ CSV exported');
    process.exit(0);
  });

// ── login ─────────────────────────────────────────────────────────────────────
program
  .command('login')
  .description('Save a LinkedIn session by logging in via browser')
  .option('--account <id>', 'Account ID for multi-session support', 'main')
  .action(async (opts) => {
    const { sessionManager } = await import('./core/session.manager.js');
    logger.info({ accountId: opts.account }, '[cli:login] Starting LinkedIn login flow');
    await sessionManager.registerAccount(opts.account, 'linkedin');
    const ok = await sessionManager.loginLinkedIn(
      opts.account,
      process.env['LI_USERNAME'] ?? '',
      process.env['LI_PASSWORD'] ?? ''
    );
    if (ok) {
      logger.info({ accountId: opts.account }, '[cli:login] ✅ Session saved');
    } else {
      logger.error({ accountId: opts.account }, '[cli:login] ❌ Login failed — check credentials or CAPTCHA');
    }
    process.exit(0);
  });

program.parse(process.argv);
