import { readFile } from 'fs/promises';
import { ProxyConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { randomInt } from '../utils/random.js';

// ProxyEntry extends the public ProxyConfig with internal health-tracking fields
// that are stripped before handing a proxy to callers.
interface ProxyEntry extends ProxyConfig {
  failCount: number;
  lastUsed: number;
  blocked: boolean;
}

// Manages a pool of HTTP proxies with round-robin selection, failure tracking,
// and auto-blocking. Supports BrightData residential proxies, ProxyScrape free list, or a plain text file.
export class ProxyManager {
  private proxies: ProxyEntry[] = [];
  private currentIndex: number = 0;
  // Block a proxy after 3 consecutive failures; reset when the whole pool is exhausted.
  private readonly maxFails: number = 3;

  constructor() {
    // Fire-and-forget: proxy load errors degrade to no-proxy mode rather than crashing.
    this.loadProxies().catch(err =>
      logger.warn({ err }, 'Proxy load failed — running without proxies')
    );
  }

  private async loadProxies(): Promise<void> {
    const provider = process.env['PROXY_PROVIDER'];

    if (provider === 'brightdata') {
      this.proxies = this.buildBrightDataProxies();
      logger.info({ count: this.proxies.length }, 'BrightData proxies configured');
      return;
    }

    if (provider === 'proxyscrape') {
      await this.loadFromProxyScrape();
      return;
    }

    const listFile = process.env['PROXY_LIST_FILE'];
    if (listFile) {
      await this.loadFromFile(listFile);
      return;
    }

    logger.warn('No proxy provider configured — scraping without proxies (not recommended for LinkedIn)');
  }

  // Creates 10 BrightData entries with distinct random session IDs.
  // BrightData assigns a fresh residential IP per session ID, so spreading across
  // 10 session strings gives 10 independent IP slots that rotate on each use.
  private buildBrightDataProxies(): ProxyEntry[] {
    const username = process.env['BRIGHTDATA_USERNAME'];
    const password = process.env['BRIGHTDATA_PASSWORD'];
    const zone = process.env['BRIGHTDATA_ZONE'] ?? 'residential_rotating';

    if (!username || !password) {
      logger.warn('BrightData credentials missing');
      return [];
    }

    const entries: ProxyEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        host: 'brd.superproxy.io',
        port: 22225,
        // Format: brd-customer-{id}-zone-{zone}-session-{randId}
        username: `${username}-zone-${zone}-session-${randomInt(100000, 999999)}`,
        password,
        protocol: 'http',
        failCount: 0,
        lastUsed: 0,
        blocked: false,
      });
    }
    return entries;
  }

  // Fetches the ProxyScrape proxy list.
  // With PROXYSCRAPE_USERNAME + PROXYSCRAPE_PASSWORD set, uses the premium authenticated endpoint
  // which returns dedicated rotating proxies. Without credentials, falls back to the free public list.
  private async loadFromProxyScrape(): Promise<void> {
    const username = process.env['PROXYSCRAPE_USERNAME'];
    const password = process.env['PROXYSCRAPE_PASSWORD'];

    const url = username && password
      ? `https://api.proxyscrape.com/v3/free-proxy-list/get?request=displayproxies&protocol=http&proxy_format=protocolipport&format=text&username=${username}&password=${password}`
      : 'https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all';

    try {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();

      // Premium response format: http://ip:port — strip protocol prefix if present.
      const lines = text.split('\n').map(l => l.trim().replace(/^https?:\/\//, '')).filter(Boolean);

      this.proxies = lines.map(line => {
        const [host, portStr] = line.split(':');
        return {
          host:      host ?? '',
          port:      parseInt(portStr ?? '8080'),
          protocol:  'http' as const,
          failCount: 0,
          lastUsed:  0,
          blocked:   false,
        };
      });

      logger.info({ count: this.proxies.length, premium: !!(username && password) }, 'ProxyScrape proxies loaded');
    } catch (err) {
      logger.error({ err }, 'ProxyScrape fetch failed — running without proxies');
    }
  }

  // Parses a plain text file where each line is host:port or host:port:user:pass.
  private async loadFromFile(filePath: string): Promise<void> {
    try {
      const content = await readFile(filePath, 'utf-8');
      const lines = content.split('\n').map(l => l.trim()).filter(Boolean);

      this.proxies = lines.map(line => {
        const parts = line.split(':');
        return {
          host: parts[0] ?? '',
          port: parseInt(parts[1] ?? '8080'),
          username: parts[2],
          password: parts[3],
          protocol: 'http' as const,
          failCount: 0,
          lastUsed: 0,
          blocked: false,
        };
      });

      logger.info({ count: this.proxies.length, file: filePath }, 'Proxies loaded from file');
    } catch (err) {
      logger.error({ err, filePath }, 'Failed to read proxy file');
    }
  }

  // Returns the next non-blocked proxy in round-robin order.
  // If every proxy is blocked (all failed), resets the pool and tries again
  // rather than returning undefined — a degraded proxy is better than none.
  getProxy(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;

    const available = this.proxies.filter(p => !p.blocked);
    if (available.length === 0) {
      logger.warn('All proxies blocked — resetting fail counts');
      this.proxies.forEach(p => {
        p.blocked = false;
        p.failCount = 0;
      });
    }

    const candidates = this.proxies.filter(p => !p.blocked);
    const proxy = candidates[this.currentIndex % candidates.length];
    if (!proxy) return undefined;

    this.currentIndex = (this.currentIndex + 1) % candidates.length;
    proxy.lastUsed = Date.now();

    // Strip internal tracking fields before returning to callers.
    const { failCount: _f, lastUsed: _l, blocked: _b, ...config } = proxy;
    return config;
  }

  // Returns a random non-blocked proxy. Used when starting a fresh browser session
  // to avoid always landing on the same IP as the previous session.
  getRandomProxy(): ProxyConfig | undefined {
    const available = this.proxies.filter(p => !p.blocked);
    if (available.length === 0) return undefined;

    const proxy = available[randomInt(0, available.length - 1)];
    if (!proxy) return undefined;

    proxy.lastUsed = Date.now();
    const { failCount: _f, lastUsed: _l, blocked: _b, ...config } = proxy;
    return config;
  }

  // Increments fail count and blocks the proxy once it hits maxFails.
  markFailed(proxy: ProxyConfig): void {
    const entry = this.proxies.find(
      p => p.host === proxy.host && p.port === proxy.port
    );
    if (!entry) return;

    entry.failCount++;
    if (entry.failCount >= this.maxFails) {
      entry.blocked = true;
      logger.warn({ host: proxy.host, port: proxy.port }, 'Proxy blocked after too many failures');
    }
  }

  // Resets fail count on a successful request so transient errors don't accumulate.
  markSuccess(proxy: ProxyConfig): void {
    const entry = this.proxies.find(
      p => p.host === proxy.host && p.port === proxy.port
    );
    if (entry) {
      entry.failCount = 0;
    }
  }

  get totalProxies(): number {
    return this.proxies.length;
  }

  get availableProxies(): number {
    return this.proxies.filter(p => !p.blocked).length;
  }

  get stats() {
    return {
      total: this.proxies.length,
      available: this.availableProxies,
      blocked: this.proxies.filter(p => p.blocked).length,
    };
  }
}

export const proxyManager = new ProxyManager();
