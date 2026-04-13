import net from 'net';
import { logger } from '../utils/logger.js';

/** Low-level SMTP probe — returns true/false/null (inconclusive) */
export async function verifySmtp(email: string, mxHost: string): Promise<boolean | null> {
  return new Promise(resolve => {
    const TIMEOUT_MS = 8000;
    const socket = net.createConnection(25, mxHost);
    let stage = 0;
    let buffer = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      socket.destroy();
      logger.debug({ mxHost, email }, '[smtp-verifier] Timeout');
      resolve(null);
    }, TIMEOUT_MS);

    socket.on('data', chunk => {
      buffer += chunk.toString();
      const lines = buffer.split('\r\n');
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        logger.debug({ stage, line }, '[smtp-verifier] Received');
        if (stage === 0 && line.startsWith('220')) {
          socket.write('EHLO genlea.verify\r\n');
          stage = 1;
        } else if (stage === 1 && (line.startsWith('250') || line.startsWith('220'))) {
          if (!line.includes('-')) {
            socket.write(`MAIL FROM:<verify@genlea.io>\r\n`);
            stage = 2;
          }
        } else if (stage === 2 && line.startsWith('250')) {
          socket.write(`RCPT TO:<${email}>\r\n`);
          stage = 3;
        } else if (stage === 3) {
          clearTimeout(timer);
          socket.write('QUIT\r\n');
          socket.destroy();
          if (line.startsWith('250') || line.startsWith('251')) {
            resolve(true);
          } else if (line.startsWith('550') || line.startsWith('551') || line.startsWith('553')) {
            resolve(false);
          } else {
            resolve(null); // 4xx = greylisted
          }
        }
      }
    });

    socket.on('error', err => {
      if (!timedOut) {
        clearTimeout(timer);
        logger.debug({ err, mxHost }, '[smtp-verifier] Connection error');
        resolve(null);
      }
    });

    socket.on('close', () => {
      if (!timedOut) clearTimeout(timer);
    });
  });
}
