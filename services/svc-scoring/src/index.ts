import 'dotenv-flow/config';
import { Job } from 'bullmq';
import type { ScoringJobData } from '@genlea/shared';
import {
  createWorker,
  QUEUE_NAMES,
  connectMongo,
  companyRepository,
  contactRepository,
  jobRepository,
  settingsRepository,
  logger,
} from '@genlea/shared';
import { scoreCompany } from './scoring/scorer.js';

async function processScoringJob(job: Job<ScoringJobData>): Promise<void> {
  const { runId, companyId } = job.data;
  const startedAt = Date.now();

  logger.info({ runId, companyId }, '[scoring.worker] Job started');

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

  const { score, status, breakdown } = scoreCompany(
    { company, contacts, jobs },
    {
      hotVerified:         settings.leadScoreHotVerifiedThreshold,
      hot:                 settings.leadScoreHotThreshold,
      warm:                settings.leadScoreWarmThreshold,
      cold:                settings.leadScoreColdThreshold,
      targetTechTags:      settings.targetTechTags,
      highValueIndustries: settings.highValueIndustries,
    }
  );

  // Derive open roles from active jobs and pass into updateScore — single DB write
  const seenTitles = new Set<string>();
  const openRoles: string[] = [];
  for (const j of jobs.filter(j => j.isActive)) {
    const key = j.title.trim().toLowerCase();
    if (!seenTitles.has(key)) { seenTitles.add(key); openRoles.push(j.title.trim()); }
  }

  await companyRepository.updateScore(companyId, score, status, breakdown, openRoles.length > 0 ? openRoles : undefined);

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
        origin:   breakdown.originRatioScore,
        jobs:     breakdown.jobFreshnessScore,
        tech:     breakdown.techStackScore,
        contacts: breakdown.contactScore,
        fit:      breakdown.companyFitScore,
      },
    },
    '[scoring.worker] Job complete'
  );

  if (status === 'hot' || status === 'hot_verified') {
    logger.info({ domain: company.domain, score, status }, '[scoring.worker] HOT LEAD FOUND');
  }
}

async function main() {
  await connectMongo();
  const settings = await settingsRepository.get();

  const worker = createWorker<ScoringJobData>(
    QUEUE_NAMES.SCORING,
    processScoringJob,
    settings.workerConcurrencyScoring,
  );
  logger.info({ concurrency: settings.workerConcurrencyScoring }, '[svc-scoring] Worker started');

  const settingsInterval = setInterval(async () => {
    try {
      const s = await settingsRepository.get();
      if (worker.concurrency !== s.workerConcurrencyScoring) {
        worker.concurrency = s.workerConcurrencyScoring;
        logger.info({ concurrency: s.workerConcurrencyScoring }, '[svc-scoring] Concurrency updated');
      }
    } catch { /* ignore */ }
  }, 10_000);

  const shutdown = async (signal: string) => {
    logger.info({ signal }, '[svc-scoring] Shutdown received');
    clearInterval(settingsInterval);
    await worker.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch(err => {
  logger.error({ err }, '[svc-scoring] Fatal startup error');
  process.exit(1);
});
