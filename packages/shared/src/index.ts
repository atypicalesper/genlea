// ── Types ─────────────────────────────────────────────────────────────────────
export * from './types/index.js';

// ── Agent framework (planner / executor / DOM summarizer / loop / LangSmith) ──
export * from './agent/index.js';

// ── Utils ─────────────────────────────────────────────────────────────────────
export { logger } from './utils/logger.js';
export * from './utils/random.js';
export * from './utils/array-utils.js';
export * from './utils/alert.js';
export { buildLlm, MODEL } from './utils/llm.client.js';
export { sanitizeAgentInput, isInjectionAttempt } from './utils/prompt-sanitizer.js';
export { resilientAgentInvoke }                   from './utils/resilient-invoke.js';
export { withTiming }                             from './utils/timed-tool.js';
export { groq, GROQ_MODEL } from './utils/groq.client.js';

// ── Storage ───────────────────────────────────────────────────────────────────
export { connectMongo, getDb, getCollection, closeMongo, COLLECTIONS } from './storage/mongo.client.js';
export { companyRepository } from './storage/repositories/company.repository.js';
export { contactRepository } from './storage/repositories/contact.repository.js';
export { jobRepository } from './storage/repositories/job.repository.js';
export { scrapeLogRepository } from './storage/repositories/scrape-log.repository.js';
export { settingsRepository } from './storage/repositories/settings.repository.js';
export type { AppSettings } from './storage/repositories/settings.repository.js';

// ── Queue ─────────────────────────────────────────────────────────────────────
export {
  QUEUE_NAMES,
  discoveryQueue,
  enrichmentQueue,
  scoringQueue,
  QueueManager,
  queueManager,
  createWorker,
} from './queue/queue.manager.js';

// ── Core (browser/proxy/session) ──────────────────────────────────────────────
export { browserManager } from './core/browser.manager.js';
export { proxyManager } from './core/proxy.manager.js';
export { sessionManager } from './core/session.manager.js';

// ── Scheduler (seed queries + available sources) ─────────────────────────────
export {
  SEED_QUERIES,
  getAvailableSources,
  logAvailableSources,
  enqueueSeedRound,
  getSeedQueryCount,
} from './scheduler.js';

// ── Enrichment (shared pipeline utilities) ────────────────────────────────────
export { normalizer, normalizeRole } from './enrichment/normalizer.js';
export { deduplicateCompanies, deduplicateContacts, deduplicateJobs } from './enrichment/deduplicator.js';
export { normalizeTechTags, TECH_ALIASES } from './enrichment/tech-aliases.js';
export { emailVerifier } from './enrichment/email.verifier.js';
export type { EmailVerifyResult } from './enrichment/email.verifier.js';
