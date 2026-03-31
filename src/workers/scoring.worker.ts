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
      { hot: settings.leadScoreHotThreshold, warm: settings.leadScoreWarmThreshold }
    );

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
  const worker = createWorker<ScoringJobData>(
    QUEUE_NAMES.SCORING,
    processScoringJob,
    5 // scoring is cheap, can run more concurrently
  );
  logger.info('[scoring.worker] Worker started');

  process.on('SIGTERM', async () => {
    logger.info('[scoring.worker] SIGTERM received — shutting down');
    await worker.close();
    process.exit(0);
  });
}
