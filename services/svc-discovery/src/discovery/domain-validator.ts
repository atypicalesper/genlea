import { promises as dns } from 'dns';
import { logger } from '@genlea/shared';

const _dnsCache = new Map<string, boolean>();

export async function resolvesRealDomain(domain: string): Promise<boolean> {
  if (_dnsCache.has(domain)) return _dnsCache.get(domain)!;
  try {
    await dns.lookup(domain);
    _dnsCache.set(domain, true);
    return true;
  } catch {
    logger.debug({ domain }, '[domain-validator] DNS lookup failed — skipping domain');
    _dnsCache.set(domain, false);
    return false;
  }
}
