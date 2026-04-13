import pino from 'pino';
import path from 'path';
import fs from 'fs';

const logsDir = path.resolve('logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const level = (process.env['LOG_LEVEL'] ?? 'info') as pino.Level;
const pretty = process.env['LOG_PRETTY'] === 'true';

// Rotating file transport — daily rotation, keep 14 days, max 50 MB per file
const fileTransport = pino.transport({
  target: 'pino-roll',
  options: {
    file:      path.join(logsDir, 'genlea.log'),
    frequency: 'daily',
    size:      '50m',
    limit:     { count: 14 },
    mkdir:     true,
  },
});

const streams: pino.StreamEntry[] = [
  {
    level,
    stream: pretty
      ? (pino.transport({
          target: 'pino-pretty',
          options: {
            colorize:      true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
            ignore:        'pid,hostname',
          },
        }) as NodeJS.WritableStream)
      : process.stdout,
  },
  {
    level,
    stream: fileTransport,
  },
];

export const logger = pino(
  { level, base: { service: 'genlea' } },
  pino.multistream(streams),
);
