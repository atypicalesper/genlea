import { readFile } from 'fs/promises';
import { ProxyConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { randomInt } from '../utils/random.js';

interface ProxyEntry extends ProxyConfig {
  failCount: number;
  lastUsed: number;
  blocked: boolean;
}

export class ProxyManager {
  private proxies: ProxyEntry[] = [];
  private currentIndex: number = 0;
  private readonly maxFails: number = 3;

  constructor() {
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

    const listFile = process.env['PROXY_LIST_FILE'];
    if (listFile) {
      await this.loadFromFile(listFile);
      return;
    }

    logger.warn('No proxy provider configured — scraping without proxies (not recommended for LinkedIn)');
  }

  /** BrightData residential rotating proxy — one entry rotates automatically */
  private buildBrightDataProxies(): ProxyEntry[] {
    const username = process.env['BRIGHTDATA_USERNAME'];
    const password = process.env['BRIGHTDATA_PASSWORD'];
    const zone = process.env['BRIGHTDATA_ZONE'] ?? 'residential_rotating';

    if (!username || !password) {
      logger.warn('BrightData credentials missing');
      return [];
    }

    // BrightData uses session IDs to rotate: brd-customer-{id}-zone-{zone}-session-{randId}
    const entries: ProxyEntry[] = [];
    for (let i = 0; i < 10; i++) {
      entries.push({
        host: 'brd.superproxy.io',
        port: 22225,
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

  /** Load proxies from a plain text file: host:port or host:port:user:pass */
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

  /** Get next available, non-blocked proxy */
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

    // Round-robin over non-blocked proxies
    const candidates = this.proxies.filter(p => !p.blocked);
    const proxy = candidates[this.currentIndex % candidates.length];
    if (!proxy) return undefined;

    this.currentIndex = (this.currentIndex + 1) % candidates.length;
    proxy.lastUsed = Date.now();

    const { failCount: _f, lastUsed: _l, blocked: _b, ...config } = proxy;
    return config;
  }

  /** Get a random proxy (useful for fresh sessions) */
  getRandomProxy(): ProxyConfig | undefined {
    const available = this.proxies.filter(p => !p.blocked);
    if (available.length === 0) return undefined;

    const proxy = available[randomInt(0, available.length - 1)];
    if (!proxy) return undefined;

    proxy.lastUsed = Date.now();
    const { failCount: _f, lastUsed: _l, blocked: _b, ...config } = proxy;
    return config;
  }

  /** Mark a proxy as failed (auto-block after maxFails) */
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

  /** Mark a proxy as successful (reset fail count) */
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
