import { chromium, Browser, BrowserContext, Page } from 'playwright';
import { BrowserContextOptions, ProxyConfig } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { randomInt, randomBetween } from '../utils/random.js';
import { settingsRepository } from '../storage/repositories/settings.repository.js';

// ── User Agent Bank ───────────────────────────────────────────────────────────
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:137.0) Gecko/20100101 Firefox/137.0',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.4; rv:137.0) Gecko/20100101 Firefox/137.0',
];

const VIEWPORTS = [
  { width: 1920, height: 1080 },
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 1536, height: 864 },
  { width: 1280, height: 800 },
];

// ── Stealth Scripts ───────────────────────────────────────────────────────────
const STEALTH_INIT_SCRIPT = `
  // Remove webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Spoof plugins length
  Object.defineProperty(navigator, 'plugins', {
    get: () => [1, 2, 3, 4, 5],
  });

  // Spoof languages
  Object.defineProperty(navigator, 'languages', {
    get: () => ['en-US', 'en'],
  });

  // Spoof chrome object
  window.chrome = {
    runtime: {},
    loadTimes: function() {},
    csi: function() {},
    app: {},
  };

  // Spoof permissions
  const originalQuery = window.navigator.permissions.query;
  window.navigator.permissions.query = (parameters) =>
    parameters.name === 'notifications'
      ? Promise.resolve({ state: Notification.permission })
      : originalQuery(parameters);

  // Spoof WebGL vendor/renderer
  const getParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(parameter) {
    if (parameter === 37445) return 'Intel Inc.';
    if (parameter === 37446) return 'Intel Iris OpenGL Engine';
    return getParameter.call(this, parameter);
  };
`;

// ── BrowserManager ────────────────────────────────────────────────────────────
export class BrowserManager {
  private browsers: Map<string, Browser> = new Map();
  private maxConcurrent: number;
  private settingsRefreshedAt = 0;

  constructor(maxConcurrent: number = 3) {
    this.maxConcurrent = maxConcurrent;
  }

  private async refreshConcurrencyLimit(): Promise<void> {
    // Pull from DB-backed settings periodically so the Control Panel can tune
    // browser capacity without needing a worker restart.
    if (Date.now() - this.settingsRefreshedAt < 10_000) return;
    this.settingsRefreshedAt = Date.now();

    try {
      const settings = await settingsRepository.get();
      const nextLimit = Math.max(1, settings.maxConcurrentBrowsers ?? this.maxConcurrent);
      if (nextLimit !== this.maxConcurrent) {
        this.maxConcurrent = nextLimit;
        logger.info({ maxConcurrentBrowsers: nextLimit }, '[browser.manager] Browser concurrency updated from settings');
      }
    } catch (err) {
      logger.debug({ err }, '[browser.manager] Failed to refresh browser concurrency setting');
    }
  }

  /** Launch a stealth browser instance */
  async launchBrowser(id: string): Promise<Browser> {
    if (this.browsers.has(id)) return this.browsers.get(id)!;

    await this.refreshConcurrencyLimit();

    if (this.browsers.size >= this.maxConcurrent) {
      throw new Error(`Max concurrent browsers (${this.maxConcurrent}) reached`);
    }

    const browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-infobars',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--mute-audio',
        '--hide-scrollbars',
        '--disable-blink-features=AutomationControlled',
        '--disable-extensions',
        '--no-first-run',
        '--no-default-browser-check',
        '--window-size=1920,1080',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-background-timer-throttling',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
      ],
    });

    this.browsers.set(id, browser);
    logger.debug({ browserId: id }, 'Browser launched');
    return browser;
  }

  /** Create a stealth browser context with optional proxy and cookies */
  async createContext(
    browserId: string,
    options: BrowserContextOptions = {}
  ): Promise<BrowserContext> {
    const browser = await this.launchBrowser(browserId);

    const userAgent = options.userAgent ?? USER_AGENTS[randomInt(0, USER_AGENTS.length - 1)]!;
    const viewport = options.viewport ?? VIEWPORTS[randomInt(0, VIEWPORTS.length - 1)]!;

    const contextOptions: Parameters<Browser['newContext']>[0] = {
      userAgent,
      viewport,
      locale: 'en-US',
      timezoneId: 'America/New_York',
      geolocation: { longitude: -74.006, latitude: 40.7128 }, // NYC
      permissions: ['geolocation'],
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
    };

    if (options.proxy) {
      contextOptions.proxy = {
        server: `${options.proxy.protocol}://${options.proxy.host}:${options.proxy.port}`,
        username: options.proxy.username,
        password: options.proxy.password,
      };
    }

    const context = await browser.newContext(contextOptions);

    // Inject stealth scripts on every page
    await context.addInitScript(STEALTH_INIT_SCRIPT);

    // Load cookies if session path provided
    if (options.cookiesPath) {
      await this.loadCookies(context, options.cookiesPath);
    }

    return context;
  }

  /** Open a new stealth page within a context */
  async newPage(context: BrowserContext): Promise<Page> {
    const page = await context.newPage();

    // Timeouts are env-tunable so we can dial up under flaky network conditions
    // without redeploying. Defaults match the historical 20s/30s.
    const defaultTimeout    = parseInt(process.env['PAGE_DEFAULT_TIMEOUT_MS']    ?? '20000', 10);
    const navigationTimeout = parseInt(process.env['PAGE_NAVIGATION_TIMEOUT_MS'] ?? '30000', 10);
    page.setDefaultTimeout(defaultTimeout);
    page.setDefaultNavigationTimeout(navigationTimeout);

    // Block static assets — no value for scraping
    await page.route('**/*.{png,jpg,jpeg,gif,webp,svg,ico,mp4,webm,ogg,mp3,wav,woff,woff2,ttf,eot}', route => route.abort());

    // Block analytics/tracking/ads — return 204 instead of aborting to avoid JS errors
    const JUNK_PATTERNS = [
      '**/analytics**', '**/tracking**', '**/ads/**',
      '**/gtm.js**', '**/googletagmanager**', '**/google-analytics**',
      '**/hotjar**', '**/hj.js**', '**/segment.io**', '**/cdn.segment**',
      '**/intercom**', '**/mixpanel**', '**/amplitude**',
      '**/fullstory**', '**/logrocket**', '**/crisp.chat**',
      '**/drift.com**', '**/hs-scripts**', '**/hubspot**',
    ];
    for (const pattern of JUNK_PATTERNS) {
      await page.route(pattern, route => route.fulfill({ status: 204, body: '' }));
    }

    return page;
  }

  /** Simulate human-like scroll on a page */
  async humanScroll(page: Page, scrolls: number = 5): Promise<void> {
    for (let i = 0; i < scrolls; i++) {
      const scrollAmount = randomInt(300, 800);
      await page.evaluate((amount: number) => { (globalThis as any).scrollBy(0, amount); }, scrollAmount);
      await page.waitForTimeout(randomBetween(500, 1500));
    }
  }

  /** Simulate human-like random delay */
  async humanDelay(minMs: number = 2000, maxMs: number = 6000): Promise<void> {
    const delay = randomBetween(minMs, maxMs);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /** Detect if a CAPTCHA is present on the current page */
  async detectCaptcha(page: Page): Promise<boolean> {
    const selector = [
      '[class*="captcha"]', '[id*="captcha"]',
      '.challenge-dialog', '#challenge-running',
      'iframe[src*="recaptcha"]', 'iframe[src*="hcaptcha"]',
    ].join(', ');
    return page.locator(selector).first().isVisible({ timeout: 1500 }).catch(() => false);
  }

  /** Save current page cookies to a file */
  async saveCookies(context: BrowserContext, filePath: string): Promise<void> {
    const { writeFile, mkdir } = await import('fs/promises');
    const { dirname } = await import('path');
    await mkdir(dirname(filePath), { recursive: true });
    const cookies = await context.cookies();
    await writeFile(filePath, JSON.stringify(cookies, null, 2));
    logger.debug({ filePath }, 'Cookies saved');
  }

  /** Load cookies from a file into a context */
  async loadCookies(context: BrowserContext, filePath: string): Promise<void> {
    const { readFile } = await import('fs/promises');
    try {
      const data = await readFile(filePath, 'utf-8');
      const cookies = JSON.parse(data) as Parameters<BrowserContext['addCookies']>[0];
      await context.addCookies(cookies);
      logger.debug({ filePath }, 'Cookies loaded');
    } catch {
      logger.warn({ filePath }, 'No cookie file found — starting fresh session');
    }
  }

  /** Close a specific browser */
  async closeBrowser(id: string): Promise<void> {
    const browser = this.browsers.get(id);
    if (browser) {
      await browser.close();
      this.browsers.delete(id);
      logger.debug({ browserId: id }, 'Browser closed');
    }
  }

  /** Close all browsers */
  async closeAll(): Promise<void> {
    const closePromises = [...this.browsers.entries()].map(async ([id, browser]) => {
      await browser.close();
      this.browsers.delete(id);
    });
    await Promise.all(closePromises);
    logger.info('All browsers closed');
  }

  get activeBrowserCount(): number {
    return this.browsers.size;
  }

  get maxBrowserCount(): number {
    return this.maxConcurrent;
  }

  /**
   * Pre-warm browser instances so the first scraper job in a worker doesn't pay
   * the full launch cost. Best-effort — if launch fails (e.g. proxy down) we
   * log and let the job-time launch path retry.
   */
  async warmup(count = 1): Promise<void> {
    const target = Math.min(count, this.maxConcurrent);
    logger.info({ target }, '[browser.manager] Warming up browser pool');
    const launches = Array.from({ length: target }, (_, i) =>
      this.launchBrowser(`warm-${i}`).catch(err =>
        logger.warn({ err, index: i }, '[browser.manager] Warmup launch failed — will retry on demand'),
      ),
    );
    await Promise.all(launches);
  }

  /**
   * Periodic heartbeat: navigate each pooled browser to about:blank so we
   * surface dead/zombie browser processes early instead of mid-scrape.
   * Returns the interval handle so callers can clear it on shutdown.
   */
  startHeartbeat(intervalMs = 5 * 60_000): NodeJS.Timeout {
    const tick = async () => {
      for (const [id, browser] of this.browsers.entries()) {
        try {
          if (!browser.isConnected()) {
            logger.warn({ browserId: id }, '[browser.manager] Browser is disconnected — closing');
            await this.closeBrowser(id);
            continue;
          }
          const ctx = await browser.newContext();
          const page = await ctx.newPage();
          await page.goto('about:blank', { timeout: 5_000 });
          await ctx.close();
        } catch (err) {
          logger.warn({ err, browserId: id }, '[browser.manager] Heartbeat failed — closing browser');
          await this.closeBrowser(id).catch(closeErr =>
            logger.warn({ err: closeErr, browserId: id }, '[browser.manager] Forced close failed'),
          );
        }
      }
    };
    return setInterval(tick, intervalMs);
  }
}

// Singleton export
export const browserManager = new BrowserManager(
  parseInt(process.env['MAX_CONCURRENT_BROWSERS'] ?? '3')
);
