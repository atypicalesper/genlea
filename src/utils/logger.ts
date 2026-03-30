import pino from 'pino';
import fs from 'fs';
import path from 'path';

// Ensure logs/ directory exists
const logsDir = path.resolve('logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });

const logFile = path.join(logsDir, 'genlea.log');
const fileStream = fs.createWriteStream(logFile, { flags: 'a' });

const level = (process.env['LOG_LEVEL'] ?? 'info') as pino.Level;

// Pretty transport for stdout (dev) — raw JSON to file always
const streams: pino.StreamEntry[] = [
  {
    level,
    stream:
      process.env['LOG_PRETTY'] === 'true'
        ? (pino.transport({
            target: 'pino-pretty',
            options: {
              colorize: true,
              translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
              ignore: 'pid,hostname',
            },
          }) as NodeJS.WritableStream)
        : process.stdout,
  },
  {
    level,
    stream: fileStream,
  },
];

export const logger = pino(
  { level, base: { service: 'genlea' } },
  pino.multistream(streams)
);
