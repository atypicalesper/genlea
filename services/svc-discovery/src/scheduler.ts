import cron from 'node-cron';
import { enqueueSeedRound, jobRepository, logger } from '@genlea/shared';

const STALE_JOB_DAYS = parseInt(process.env['STALE_JOB_DAYS'] ?? '90', 10);

export async function startScheduler(): Promise<void> {
  await enqueueSeedRound('startup').catch(err =>
    logger.error({ err }, '[scheduler] Startup seed failed')
  );

  cron.schedule('0 */2 * * *', async () => {
    logger.info('[scheduler] Cron triggered (every 2h)');
    await enqueueSeedRound('cron').catch(err =>
      logger.error({ err }, '[scheduler] Cron seed failed')
    );
  });

  cron.schedule('0 3 * * *', async () => {
    logger.info('[scheduler] Stale job cleanup starting');
    const count = await jobRepository.deactivateStale(STALE_JOB_DAYS).catch(err => {
      logger.error({ err }, '[scheduler] Stale job cleanup failed');
      return 0;
    });
    logger.info({ deactivated: count }, '[scheduler] Stale job cleanup complete');
  });

  logger.info('[scheduler] Cron scheduler started — runs every 2 hours');
}
