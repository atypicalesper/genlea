import dns from 'dns/promises';
import type { MxRecord } from 'dns';
import { logger } from '../utils/logger.js';
import { verifySmtp } from './smtp-verifier.js';

export interface EmailVerifyResult {
  email: string;
  valid: boolean;
  confidence: number;  // 0–1
  checks: {
    format: boolean;
    mxRecord: boolean;
    smtpReachable: boolean | null;  // null = inconclusive
    disposable: boolean;
  };
  reason?: string;
}

// Known disposable email domains
const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'guerrillamail.com', 'tempmail.com', 'throwaway.email',
  'yopmail.com', '10minutemail.com', 'trashmail.com', 'sharklasers.com',
  'fakeinbox.com', 'dispostable.com', 'maildrop.cc', 'spamgourmet.com',
]);

// Domains where SMTP verification often gives false negatives
const SMTP_UNRELIABLE_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com',
  'live.com', 'yahoo.com', 'protonmail.com', 'icloud.com',
]);

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const emailVerifier = {
  async verify(email: string): Promise<EmailVerifyResult> {
    const emailLower = email.toLowerCase().trim();
    logger.debug({ email: emailLower }, '[email.verifier] Starting verification');

    const result: EmailVerifyResult = {
      email: emailLower,
      valid: false,
      confidence: 0,
      checks: {
        format: false,
        mxRecord: false,
        smtpReachable: null,
        disposable: false,
      },
    };

    // ── 1. Format check ─────────────────────────────────────────────────────
    if (!EMAIL_REGEX.test(emailLower)) {
      result.reason = 'Invalid email format';
      logger.debug({ email: emailLower }, '[email.verifier] Format check failed');
      return result;
    }
    result.checks.format = true;

    const domain = emailLower.split('@')[1]!;

    // ── 2. Disposable domain check ──────────────────────────────────────────
    if (DISPOSABLE_DOMAINS.has(domain)) {
      result.checks.disposable = true;
      result.reason = 'Disposable email domain';
      result.confidence = 0.05;
      logger.debug({ email: emailLower, domain }, '[email.verifier] Disposable domain');
      return result;
    }

    // ── 3. MX record check ──────────────────────────────────────────────────
    let mxRecords: MxRecord[] = [];
    try {
      mxRecords = await dns.resolveMx(domain);
      if (mxRecords.length > 0) {
        result.checks.mxRecord = true;
        logger.debug({ domain, mxCount: mxRecords.length }, '[email.verifier] MX records found');
      } else {
        result.reason = 'No MX records — domain does not accept email';
        result.confidence = 0.1;
        return result;
      }
    } catch (err) {
      result.reason = 'MX lookup failed — domain may not exist';
      result.confidence = 0.05;
      logger.debug({ err, domain }, '[email.verifier] MX lookup failed');
      return result;
    }

    // Confidence from format + MX alone is decent
    result.confidence = 0.65;

    // ── 4. SMTP verification (skip unreliable domains) ──────────────────────
    if (!SMTP_UNRELIABLE_DOMAINS.has(domain)) {
        const smtpResult = await verifySmtp(emailLower, mxRecords[0]!.exchange);
      result.checks.smtpReachable = smtpResult;

      if (smtpResult === true) {
        result.confidence = 0.90;
        logger.info({ email: emailLower }, '[email.verifier] SMTP verified — high confidence');
      } else if (smtpResult === false) {
        result.confidence = 0.10;
        result.reason = 'SMTP rejected the mailbox';
        logger.debug({ email: emailLower }, '[email.verifier] SMTP rejected');
      } else {
        // Inconclusive — SMTP greylisting or connection timeout
        result.confidence = 0.70;
        logger.debug({ email: emailLower }, '[email.verifier] SMTP inconclusive — greylisted or timed out');
      }
    } else {
      // For Gmail/Outlook — MX present = good enough signal
      result.checks.smtpReachable = null;
      result.confidence = 0.72;
      logger.debug({ domain }, '[email.verifier] SMTP skipped for known provider');
    }

    result.valid = result.confidence >= 0.60;
    logger.info(
      { email: emailLower, valid: result.valid, confidence: result.confidence },
      '[email.verifier] Verification complete'
    );
    return result;
  },

  /** Batch verify — returns results in same order as input */
  async verifyBatch(emails: string[], concurrency = 5): Promise<EmailVerifyResult[]> {
    logger.info({ count: emails.length }, '[email.verifier] Batch verification started');
    const results: EmailVerifyResult[] = [];

    for (let i = 0; i < emails.length; i += concurrency) {
      const batch = emails.slice(i, i + concurrency);
      const batchResults = await Promise.all(batch.map(e => this.verify(e)));
      results.push(...batchResults);
      logger.debug({ processed: results.length, total: emails.length }, '[email.verifier] Batch progress');
    }

    const verified = results.filter(r => r.valid).length;
    logger.info(
      { total: emails.length, verified, rate: (verified / emails.length * 100).toFixed(1) + '%' },
      '[email.verifier] Batch complete'
    );
    return results;
  },
};
