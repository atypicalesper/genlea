import 'dotenv-flow/config';
import { connectMongo, closeMongo } from '../src/storage/mongo.client.js';
import { contactRepository } from '../src/storage/repositories/contact.repository.js';
import { emailVerifier } from '../src/enrichment/email.verifier.js';
import { logger } from '../src/utils/logger.js';
import { getCollection, COLLECTIONS } from '../src/storage/mongo.client.js';

async function main() {
  await connectMongo();
  logger.info('[verify-emails] Starting batch email verification');

  const col = getCollection<Record<string, unknown>>(COLLECTIONS.CONTACTS);

  // Find all contacts with an email that has not been verified
  const unverified = await col.find({
    email:         { $exists: true, $ne: null },
    emailVerified: { $ne: true },
  })
  .sort({ emailConfidence: -1 }) // highest confidence first (most likely to pass)
  .limit(500)
  .toArray();

  logger.info({ total: unverified.length }, '[verify-emails] Contacts to verify');

  let passed = 0;
  let failed = 0;
  let inconclusive = 0;

  for (let i = 0; i < unverified.length; i++) {
    const contact = unverified[i]!;
    const email = contact['email'] as string;

    logger.debug(
      { email, index: i + 1, total: unverified.length },
      '[verify-emails] Verifying'
    );

    try {
      const result = await emailVerifier.verify(email);

      if (result.valid && result.confidence >= 0.60) {
        // Update as verified
        await col.updateOne(
          { _id: contact['_id'] },
          {
            $set: {
              emailVerified:   true,
              emailConfidence: result.confidence,
              updatedAt:       new Date(),
            },
          }
        );
        passed++;
        logger.info({ email, confidence: result.confidence }, '[verify-emails] ✅ Verified');
      } else if (result.confidence < 0.20) {
        // Mark as definitely invalid — flag but don't delete
        await col.updateOne(
          { _id: contact['_id'] },
          {
            $set: {
              emailVerified:   false,
              emailConfidence: result.confidence,
              updatedAt:       new Date(),
            },
          }
        );
        failed++;
        logger.debug({ email, reason: result.reason }, '[verify-emails] ❌ Failed');
      } else {
        // Inconclusive — leave as-is, update confidence
        await col.updateOne(
          { _id: contact['_id'] },
          { $set: { emailConfidence: result.confidence, updatedAt: new Date() } }
        );
        inconclusive++;
        logger.debug({ email, confidence: result.confidence }, '[verify-emails] ⚠️ Inconclusive');
      }

      // Polite delay to avoid hammering SMTP servers
      await new Promise(r => setTimeout(r, 800));

    } catch (err) {
      logger.error({ err, email }, '[verify-emails] Verification threw — skipping');
    }

    // Progress summary every 25 contacts
    if ((i + 1) % 25 === 0) {
      logger.info(
        { processed: i + 1, passed, failed, inconclusive },
        '[verify-emails] Progress update'
      );
    }
  }

  logger.info(
    { total: unverified.length, passed, failed, inconclusive },
    '[verify-emails] ✅ Batch complete'
  );

  await closeMongo();
  process.exit(0);
}

main().catch(err => {
  logger.error({ err }, '[verify-emails] Fatal error');
  process.exit(1);
});
