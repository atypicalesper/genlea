import 'dotenv-flow/config';
import { Job } from 'bullmq';
import { ScoringJobData } from '../types/index.js';
import { createWorker, QUEUE_NAMES } from '../core/queue.manager.js';
import { connectMongo } from '../storage/mongo.client.js';
import { companyRepository } from '../storage/repositories/company.repository.js';
import { contactRepository } from '../storage/repositories/contact.repository.js';
import { jobRepository } from '../storage/repositories/job.repository.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';
import { scoreCompany } from '../scoring/scorer.js';
import { logger } from '../utils/logger.js';

async function processScoringJob(job: Job<ScoringJobData>): Promise<void> {
  const { runId, companyId } = job.data;
  const startedAt = Date.now();

  logger.info({ runId, companyId }, '[scoring.worker] Job started');

  try {
    // ── Fetch all data needed to score ───────────────────────────────────────
    const [company, contacts, jobs, settings] = await Promise.all([
      companyRepository.findById(companyId),
      contactRepository.findByCompanyId(companyId),
      jobRepository.findByCompanyId(companyId, true),
      settingsRepository.get(),
    ]);

    if (!company) {
      logger.warn({ companyId }, '[scoring.worker] Company not found — skipping');
      return;
    }

    logger.debug(
      { companyId, domain: company.domain, contacts: contacts.length, jobs: jobs.length },
      '[scoring.worker] Scoring inputs loaded'
    );

    // ── Score ────────────────────────────────────────────────────────────────
    const { score, status, breakdown } = scoreCompany(
      { company, contacts, jobs },
      {
        hotVerified: settings.leadScoreHotVerifiedThreshold,
        hot:         settings.leadScoreHotThreshold,
        warm:        settings.leadScoreWarmThreshold,
        cold:        settings.leadScoreColdThreshold,
      }
    );

    // ── Sync openRoles from active job titles ─────────────────────────────────
    // Deduplicate by normalized key but preserve original casing of first occurrence
    const seen = new Set<string>();
    const openRoles: string[] = [];
    for (const j of jobs.filter(j => j.isActive)) {
      const key = j.title.trim().toLowerCase();
      if (!seen.has(key)) { seen.add(key); openRoles.push(j.title.trim()); }
    }
    if (openRoles.length > 0) {
      await companyRepository.setOpenRoles(companyId, openRoles);
    }

    // ── Persist score ─────────────────────────────────────────────────────────
    await companyRepository.updateScore(companyId, score, status, breakdown);

    const durationMs = Date.now() - startedAt;
    logger.info(
      {
        runId,
        companyId,
        domain: company.domain,
        score,
        status,
        durationMs,
        breakdown: {
          origin: breakdown.originRatioScore,
          jobs:   breakdown.jobFreshnessScore,
          tech:   breakdown.techStackScore,
          contacts: breakdown.contactScore,
          fit:    breakdown.companyFitScore,
        },
      },
      '[scoring.worker] Job complete'
    );

    // Alert on hot leads
    if (status === 'hot' || status === 'hot_verified') {
      logger.info(
        { domain: company.domain, score, status },
        '🔥 [scoring.worker] HOT LEAD FOUND'
      );
    }

  } catch (err) {
    logger.error({ err, runId, companyId }, '[scoring.worker] Job failed');
    throw err;
  }
}

export async function startScoringWorker(): Promise<void> {
  await connectMongo();
  const initialSettings = await settingsRepository.get();
  const worker = createWorker<ScoringJobData>(
    QUEUE_NAMES.SCORING,
    processScoringJob,
    initialSettings.workerConcurrencyScoring,
  );
  logger.info({ concurrency: initialSettings.workerConcurrencyScoring }, '[scoring.worker] Worker started');

  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      const target = s.workerConcurrencyScoring;
      if (worker.concurrency !== target) {
        worker.concurrency = target;
        logger.info({ concurrency: target }, '[scoring.worker] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  process.on('SIGTERM', async () => {
    logger.info('[scoring.worker] SIGTERM received — shutting down');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  });
}
