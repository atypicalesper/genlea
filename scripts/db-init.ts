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
  await companies.createIndex({ fundingStage: 1 }, { name: 'funding_stage' });
  await companies.createIndex({ lastScrapedAt: -1 }, { name: 'last_scraped' });
  await companies.createIndex({ 'hqCountry': 1, 'hqState': 1 }, { name: 'location' });
  logger.info('[db:init] ✅ companies indexes created');

  // ── contacts ───────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating contacts indexes...');
  const contacts = db.collection('contacts');
  await contacts.createIndex({ email: 1 }, { unique: true, sparse: true, name: 'email_unique' });
  await contacts.createIndex({ companyId: 1 }, { name: 'company_id' });
  await contacts.createIndex({ companyId: 1, role: 1 }, { name: 'company_role' });
  await contacts.createIndex({ emailVerified: 1 }, { name: 'email_verified' });
  logger.info('[db:init] ✅ contacts indexes created');

  // ── jobs ───────────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating jobs indexes...');
  const jobs = db.collection('jobs');
  await jobs.createIndex({ companyId: 1, isActive: 1 }, { name: 'company_active' });
  await jobs.createIndex({ companyId: 1, title: 1, source: 1 }, { unique: true, name: 'dedup' });
  await jobs.createIndex({ postedAt: -1 }, { name: 'posted_at' });
  await jobs.createIndex({ techTags: 1 }, { name: 'tech_tags' });
  logger.info('[db:init] ✅ jobs indexes created');

  // ── scrape_logs ────────────────────────────────────────────────────────────
  logger.info('[db:init] Creating scrape_logs indexes...');
  const logs = db.collection('scrape_logs');
  await logs.createIndex({ startedAt: -1 }, { name: 'started_at' });
  await logs.createIndex({ scraper: 1, status: 1 }, { name: 'scraper_status' });
  await logs.createIndex({ runId: 1 }, { name: 'run_id' });
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
