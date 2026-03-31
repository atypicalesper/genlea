import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { BrowserContext } from 'playwright';
import { browserManager } from './browser.manager.js';
import { proxyManager } from './proxy.manager.js';
import { logger } from '../utils/logger.js';
import { randomBetween } from '../utils/random.js';

export type SessionSource = 'linkedin' | 'salesnav' | 'zoominfo';

interface SessionMeta {
  accountId: string;
  source: SessionSource;
  cookiesPath: string;
  lastUsed: number;
  profilesScrapedToday: number;
  dailyProfileLimit: number;
  cooldownUntil: number;
  isBlocked: boolean;
}

export class SessionManager {
  private sessions: Map<string, SessionMeta> = new Map();
  private readonly sessionDir: string;
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.sessionDir = process.env['LI_SESSION_DIR'] ?? 'sessions/linkedin';
  }

  async init(): Promise<void> {
    await mkdir(join(process.cwd(), this.sessionDir), { recursive: true });
    await this.loadSessionMeta();
    logger.info({ count: this.sessions.size }, 'Sessions initialized');
  }

  private async loadSessionMeta(): Promise<void> {
    const metaPath = join(process.cwd(), this.sessionDir, '_meta.json');
    try {
      const data = await readFile(metaPath, 'utf-8');
      const parsed = JSON.parse(data) as SessionMeta[];
      parsed.forEach(s => this.sessions.set(s.accountId, s));
    } catch {
      logger.info('No session meta found — starting fresh');
    }
  }

  private async saveSessionMeta(): Promise<void> {
    const metaPath = join(process.cwd(), this.sessionDir, '_meta.json');
    await writeFile(metaPath, JSON.stringify([...this.sessions.values()], null, 2));
  }

  /** Schedule a debounced session meta save — batches rapid profile-view writes into one */
  private scheduleSave(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveSessionMeta().catch(err =>
        logger.warn({ err }, '[session.manager] Debounced save failed')
      );
    }, 5000);
  }

  /** Register a new session account */
  async registerAccount(accountId: string, source: SessionSource): Promise<void> {
    const meta: SessionMeta = {
      accountId,
      source,
      cookiesPath: join(process.cwd(), this.sessionDir, `${accountId}.json`),
      lastUsed: 0,
      profilesScrapedToday: 0,
      dailyProfileLimit: parseInt(process.env['LI_MAX_PROFILES_PER_SESSION'] ?? '80', 10),
      cooldownUntil: 0,
      isBlocked: false,
    };
    this.sessions.set(accountId, meta);
    await this.saveSessionMeta();
  }

  /** Get an available session (not in cooldown, not hit daily limit) */
  getAvailableSession(source: SessionSource): SessionMeta | null {
    const now = Date.now();
    const oneDayMs = 24 * 60 * 60 * 1000;

    for (const session of this.sessions.values()) {
      if (session.source !== source) continue;
      if (session.isBlocked) continue;
      if (session.cooldownUntil > now) continue;

      // Reset daily counter if it's a new day
      const lastUsedDate = new Date(session.lastUsed).toDateString();
      const todayDate = new Date().toDateString();
      if (lastUsedDate !== todayDate) {
        session.profilesScrapedToday = 0;
      }

      if (session.profilesScrapedToday >= session.dailyProfileLimit) {
        // Put session in cooldown
        const cooldownHours = parseInt(process.env['LI_SESSION_COOLDOWN_HOURS'] ?? '8', 10);
        session.cooldownUntil = now + cooldownHours * 60 * 60 * 1000;
        logger.info({ accountId: session.accountId }, 'Session hit daily limit — cooling down');
        continue;
      }

      return session;
    }

    return null;
  }

  /** Create a Playwright context with session cookies loaded */
  async createSessionContext(accountId: string, browserId: string): Promise<BrowserContext> {
    const session = this.sessions.get(accountId);
    if (!session) throw new Error(`Session ${accountId} not found`);

    const proxy = proxyManager.getRandomProxy();

    const context = await browserManager.createContext(browserId, {
      proxy,
      cookiesPath: session.cookiesPath,
    });

    return context;
  }

  /** Record a profile view (increment counter) */
  async recordProfileView(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;

    session.profilesScrapedToday++;
    session.lastUsed = Date.now();
    this.scheduleSave(); // debounced — batches up to 80 per-profile writes into one flush
  }

  /** Save cookies from a context back to session file */
  async saveSession(accountId: string, context: BrowserContext): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    await browserManager.saveCookies(context, session.cookiesPath);
    logger.debug({ accountId }, 'Session saved');
  }

  /** Mark a session as blocked (CAPTCHA, account warning, etc.) */
  async markBlocked(accountId: string): Promise<void> {
    const session = this.sessions.get(accountId);
    if (!session) return;
    session.isBlocked = true;
    await this.saveSessionMeta();
    logger.warn({ accountId }, 'Session marked as blocked');
  }

  /** Perform a LinkedIn login and save session cookies */
  async loginLinkedIn(accountId: string, username: string, password: string): Promise<boolean> {
    const browserId = `login-${accountId}`;
    logger.info({ accountId }, 'Attempting LinkedIn login');

    try {
      const proxy = proxyManager.getRandomProxy();
      const context = await browserManager.createContext(browserId, { proxy });
      const page = await browserManager.newPage(context);

      await page.goto('https://www.linkedin.com/login', { waitUntil: 'networkidle' });
      await browserManager.humanDelay(1000, 2500);

      await page.fill('#username', username);
      await page.waitForTimeout(randomBetween(300, 800));
      await page.fill('#password', password);
      await page.waitForTimeout(randomBetween(500, 1200));
      await page.click('[type="submit"]');

      await page.waitForLoadState('networkidle');

      // Check if logged in
      const isLoggedIn = await page.$('.global-nav') !== null;
      if (!isLoggedIn) {
        logger.error({ accountId }, 'LinkedIn login failed');
        await browserManager.closeBrowser(browserId);
        return false;
      }

      // Check for security challenge
      const hasCaptcha = await browserManager.detectCaptcha(page);
      if (hasCaptcha) {
        logger.warn({ accountId }, 'Security challenge detected — manual intervention required');
        await browserManager.closeBrowser(browserId);
        return false;
      }

      await this.saveSession(accountId, context);
      await browserManager.closeBrowser(browserId);
      logger.info({ accountId }, 'LinkedIn login successful');
      return true;
    } catch (err) {
      logger.error({ err, accountId }, 'Login error');
      await browserManager.closeBrowser(browserId);
      return false;
    }
  }

  get sessionStats() {
    const all = [...this.sessions.values()];
    return {
      total: all.length,
      available: all.filter(s => !s.isBlocked && s.cooldownUntil < Date.now()).length,
      blocked: all.filter(s => s.isBlocked).length,
      cooldown: all.filter(s => s.cooldownUntil > Date.now()).length,
    };
  }
}

export const sessionManager = new SessionManager();
