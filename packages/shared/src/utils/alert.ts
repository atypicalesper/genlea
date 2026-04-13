import nodemailer from 'nodemailer';
import { logger } from './logger.js';

interface AlertPayload {
  subject: string;
  body:    string;
}

function buildTransport() {
  const host = process.env['SMTP_HOST'];
  if (!host) return null;

  return nodemailer.createTransport({
    host,
    port:   parseInt(process.env['SMTP_PORT'] ?? '587', 10),
    secure: process.env['SMTP_SECURE'] === 'true',
    auth: {
      user: process.env['SMTP_USER'],
      pass: process.env['SMTP_PASS'],
    },
  });
}

export async function sendAlert({ subject, body }: AlertPayload): Promise<void> {
  const to   = process.env['ALERT_EMAIL_TO'];
  const from = process.env['ALERT_EMAIL_FROM'] ?? process.env['SMTP_USER'];

  if (!to) {
    logger.warn({ subject }, '[alert] ALERT_EMAIL_TO not set — alert suppressed');
    return;
  }

  const transport = buildTransport();
  if (!transport) {
    logger.warn({ subject }, '[alert] SMTP_HOST not set — alert suppressed');
    return;
  }

  try {
    await transport.sendMail({ from, to, subject, text: body });
    logger.info({ subject, to }, '[alert] Email sent');
  } catch (err) {
    logger.error({ err, subject }, '[alert] Failed to send email');
  }
}

export async function alertAgentFailure(opts: {
  agent:   string;
  domain?: string;
  runId?:  string;
  error:   unknown;
}): Promise<void> {
  const errMsg = opts.error instanceof Error ? opts.error.message : String(opts.error);
  const stack  = opts.error instanceof Error ? (opts.error.stack ?? '') : '';

  await sendAlert({
    subject: `[GenLea] Agent failure: ${opts.agent}`,
    body: [
      `Agent     : ${opts.agent}`,
      opts.domain ? `Domain    : ${opts.domain}` : '',
      opts.runId  ? `Run ID    : ${opts.runId}`   : '',
      `Error     : ${errMsg}`,
      '',
      stack,
      '',
      `Time      : ${new Date().toISOString()}`,
      `Host      : ${process.env['API_HOST'] ?? 'localhost'}`,
    ].filter(l => l !== undefined).join('\n'),
  });
}
