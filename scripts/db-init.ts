import 'dotenv-flow/config';
import { connectMongo, getDb, closeMongo } from '../src/storage/mongo.client.js';
import { logger } from '../src/utils/logger.js';

async function main() {
  logger.info('[db:init] Connecting to MongoDB...');
  await connectMongo();
  const db = getDb();

  // ── companies ──────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating companies indexes...');
  const companies = db.collection('companies');
  await companies.createIndex({ domain: 1 }, { unique: true, name: 'domain_unique' });
  await companies.createIndex({ score: -1, status: 1 }, { name: 'score_status' });
  await companies.createIndex({ status: 1 }, { name: 'status' });
  await companies.createIndex({ originRatio: -1 }, { name: 'origin_ratio' });
  await companies.createIndex({ techStack: 1 }, { name: 'tech_stack' });
  await companies.createIndex({ sources: 1 }, { name: 'sources' });        // for source filter
  await companies.createIndex({ fundingStage: 1 }, { name: 'funding_stage' });
  await companies.createIndex({ lastScrapedAt: -1 }, { name: 'last_scraped' });
  await companies.createIndex({ pipelineStatus: 1 }, { name: 'pipeline_status' });
  await companies.createIndex({ 'hqCountry': 1, 'hqState': 1 }, { name: 'location' });
  // Text index for name/domain search — replaces full-scan regex
  await companies.createIndex({ name: 'text', domain: 'text' }, { name: 'name_domain_text', weights: { name: 2, domain: 1 } });
  logger.info('[db:init] ✅ companies indexes created');

  // ── contacts ───────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating contacts indexes...');
  const contacts = db.collection('contacts');
  // Drop old email_company_unique if it exists with a different spec (sparse vs partialFilter)
  await contacts.dropIndex('email_company_unique').catch(() => { /* not yet created — ok */ });
  // Unique on (email, companyId) only when email is an actual string — null/missing emails are excluded
  await contacts.createIndex(
    { email: 1, companyId: 1 },
    { unique: true, partialFilterExpression: { email: { $type: 'string' } }, name: 'email_company_unique' },
  );
  await contacts.createIndex({ email: 1 }, { sparse: true, name: 'email' }); // for findByEmail lookups
  await contacts.createIndex({ companyId: 1 }, { name: 'company_id' });
  await contacts.createIndex({ companyId: 1, role: 1 }, { name: 'company_role' });
  await contacts.createIndex({ emailVerified: 1 }, { name: 'email_verified' });
  logger.info('[db:init] ✅ contacts indexes created');

  // ── jobs ───────────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating jobs indexes...');
  const jobs = db.collection('jobs');
  await jobs.createIndex({ companyId: 1, isActive: 1 }, { name: 'company_active' });
  // Deduplicate existing jobs by (companyId, title, source) — keep the latest _id
  const jobDups = await jobs.aggregate([
    { $group: { _id: { companyId: '$companyId', title: '$title', source: '$source' }, ids: { $push: '$_id' }, count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
  ]).toArray();
  for (const dup of jobDups) {
    const [, ...toDelete] = dup.ids; // keep first, delete rest
    await jobs.deleteMany({ _id: { $in: toDelete } });
  }
  if (jobDups.length) logger.info({ removed: jobDups.length }, '[db:init] Removed duplicate jobs');
  await jobs.dropIndex('dedup').catch(() => { /* not yet created — ok */ });
  await jobs.createIndex({ companyId: 1, title: 1, source: 1 }, { unique: true, name: 'dedup' });
  await jobs.createIndex({ postedAt: -1 }, { name: 'posted_at' });
  await jobs.createIndex({ techTags: 1 }, { name: 'tech_tags' });
  logger.info('[db:init] ✅ jobs indexes created');

  // ── scrape_logs ────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating scrape_logs indexes...');
  const logs = db.collection('scrape_logs');
  await logs.createIndex({ startedAt: -1 }, { name: 'started_at' });
  await logs.createIndex({ scraper: 1, startedAt: -1 }, { name: 'scraper_started' });   // scraper performance queries
  await logs.createIndex({ status: 1, startedAt: -1 }, { name: 'status_started' });     // filter by failed/success sorted by time
  await logs.createIndex({ runId: 1, scraper: 1 }, { name: 'run_scraper' });             // look up all logs for a run
  await logs.createIndex({ errors: 1 }, { sparse: true, name: 'has_errors' });           // find logs with errors
  logger.info('[db:init] ✅ scrape_logs indexes created');

  // ── Verify ────────────────────────────────────────────────────────────────
  const [ci, cni, ji, li] = await Promise.all([
    companies.indexes(), contacts.indexes(), jobs.indexes(), logs.indexes(),
  ]);

  logger.info({
    companies: ci.length, contacts: cni.length,
    jobs: ji.length, logs: li.length,
  }, '[db:init] ✅ All indexes created — database ready');

  await closeMongo();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '[db:init] Failed');
  process.exit(1);
});
