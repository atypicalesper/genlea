import { contactRepository, emailVerifier, logger } from '@genlea/shared';
import type { ContactRole } from '@genlea/shared';
import { hunterScraper } from '../scrapers/index.js';

/**
 * Contact Resolver — enriches a company's CEO / HR contacts.
 *
 * Strategy:
 * 1. Check if we already have a CEO and HR contact with a verified email
 * 2. If not, try Hunter.io email finder (API or skip if no key)
 * 3. Verify every unverified email via SMTP/MX check
 * 4. Log confidence for each contact found
 */

const PRIORITY_ROLES: ContactRole[] = ['CEO', 'Founder', 'CTO', 'HR', 'Recruiter', 'Head of Talent'];

export const contactResolver = {

  async resolveForCompany(companyId: string, domain: string): Promise<void> {
    logger.info({ companyId, domain }, '[contact.resolver] Starting contact resolution');

    const existingContacts = await contactRepository.findByCompanyId(companyId);
    const existingByRole = new Map(existingContacts.map(c => [c.role, c]));

    let enriched = 0;
    let verified = 0;

    // ── Step 1: Verify existing unverified emails (parallel, max 3 concurrent) ──
    const unverified = existingContacts.filter(c => c.email && !c.emailVerified && c._id);
    const VERIFY_CONCURRENCY = 3;
    for (let i = 0; i < unverified.length; i += VERIFY_CONCURRENCY) {
      const batch = unverified.slice(i, i + VERIFY_CONCURRENCY);
      await Promise.all(batch.map(async contact => {
        logger.debug({ email: contact.email }, '[contact.resolver] Verifying existing email');
        const result = await emailVerifier.verify(contact.email!);
        if (result.confidence > 0.6) {
          await contactRepository.markEmailVerified(contact._id!, result.confidence);
          verified++;
          logger.info(
            { email: contact.email, confidence: result.confidence, role: contact.role },
            '[contact.resolver] Email verified'
          );
        } else {
          logger.debug(
            { email: contact.email, confidence: result.confidence, reason: result.reason },
            '[contact.resolver] Email verification failed'
          );
        }
      }));
    }

    // ── Step 2: Find missing priority contacts via Hunter ─────────────────────
    const missingRoles = PRIORITY_ROLES.filter(role => {
      const contact = existingByRole.get(role);
      return !contact || !contact.email; // missing or no email
    });

    if (missingRoles.length === 0) {
      logger.info({ domain, verified }, '[contact.resolver] All priority contacts present — done');
      return;
    }

    logger.info(
      { domain, missingRoles },
      '[contact.resolver] Attempting Hunter enrichment for missing roles'
    );

    // Try Hunter domain search — works without API key via Playwright fallback
    const hunterResult = await hunterScraper.enrichDomain(domain).catch(err => {
      logger.warn({ err, domain }, '[contact.resolver] Hunter domain search failed — skipping');
      return null;
    });
    if (hunterResult?.contacts?.length) {
      for (const rawContact of hunterResult.contacts) {
        if (!rawContact.email || !rawContact.role || !rawContact.fullName) continue;
        if (!PRIORITY_ROLES.includes(rawContact.role as ContactRole)) continue;

        // Check if we already have this role filled with an email
        const existing = existingByRole.get(rawContact.role as ContactRole);
        if (existing?.email) continue;

        const saved = await contactRepository.upsert({
          companyId,
          fullName:        rawContact.fullName,
          role:            rawContact.role as ContactRole,
          email:           rawContact.email,
          emailConfidence: rawContact.emailConfidence ?? 0.6,
          sources:         ['hunter'],
        });
        enriched++;
        existingByRole.set(saved.role, saved);
        logger.info(
          { email: saved.email, role: saved.role, domain },
          '[contact.resolver] Contact added from Hunter'
        );
      }
    }

    // ── Step 3: Try Hunter email-finder for CEO/HR by name (parallel) ────────
    const nameOnlyPriority = existingContacts.filter(c =>
      !c.email && c.firstName && c.lastName && PRIORITY_ROLES.includes(c.role) && c._id
    );

    const HUNTER_CONCURRENCY = 2; // Hunter rate-limits aggressively — keep low
    for (let i = 0; i < nameOnlyPriority.length; i += HUNTER_CONCURRENCY) {
      const batch = nameOnlyPriority.slice(i, i + HUNTER_CONCURRENCY);
      await Promise.all(batch.map(async contact => {
        logger.debug({ name: contact.fullName, domain }, '[contact.resolver] Trying Hunter email finder');
        const found = await hunterScraper.findEmail(contact.firstName!, contact.lastName!, domain).catch(err => {
          logger.warn({ err, name: contact.fullName, domain }, '[contact.resolver] Hunter email finder failed');
          return null;
        });

        if (found && found.confidence >= 0.50) {
          const verification = await emailVerifier.verify(found.email).catch(() => null);
          const verified_now = !!(verification && verification.confidence > 0.6);
          await contactRepository.upsert({
            companyId,
            fullName: contact.fullName,
            role:     contact.role,
            email:    found.email,
            emailConfidence: verification ? verification.confidence : found.confidence,
            emailVerified:   verified_now,
            sources:  ['hunter'],
          });
          enriched++;
          logger.info(
            { email: found.email, confidence: found.confidence, verified: verified_now, name: contact.fullName },
            '[contact.resolver] Email found via Hunter name search'
          );
        }
      }));
    }

    logger.info(
      { domain, companyId, enriched, verified },
      '[contact.resolver] Resolution complete'
    );
  },
};
