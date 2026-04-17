/// <reference lib="dom" />
import type { Page } from 'playwright';
import { logger } from '../utils/logger.js';
import type { AgentAction } from './planner.js';

export interface ToolResult {
  success: boolean;
  output:  string;
  error?:  string;
}

export type ToolHandler = (input: Record<string, unknown>, page: Page) => Promise<ToolResult>;
export type ToolRegistry = Record<string, ToolHandler>;

// Default Playwright tools — LLM calls these by name, never writes Playwright code directly.
export function createDefaultPlaywrightTools(): ToolRegistry {
  return {
    navigate: async ({ url }, page) => {
      if (typeof url !== 'string') return { success: false, output: '', error: 'url must be a string' };
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      return { success: true, output: `Navigated to ${url}` };
    },

    click: async ({ selector }, page) => {
      if (typeof selector !== 'string') return { success: false, output: '', error: 'selector must be a string' };
      await page.waitForSelector(selector, { timeout: 10_000 });
      await page.click(selector);
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      return { success: true, output: `Clicked ${selector}` };
    },

    type: async ({ selector, text }, page) => {
      if (typeof selector !== 'string' || typeof text !== 'string')
        return { success: false, output: '', error: 'selector and text must be strings' };
      await page.waitForSelector(selector, { timeout: 10_000 });
      await page.fill(selector, text);
      return { success: true, output: `Typed into ${selector}` };
    },

    extract_text: async ({ selector }, page) => {
      if (typeof selector !== 'string') return { success: false, output: '', error: 'selector must be a string' };
      await page.waitForSelector(selector, { timeout: 10_000 });
      const text = await page.textContent(selector) ?? '';
      return { success: true, output: text.trim().slice(0, 2000) };
    },

    scroll: async ({ direction = 'down', amount = 500 }, page) => {
      const delta = typeof amount === 'number' ? amount : 500;
      await page.evaluate((d: number) => window.scrollBy(0, d), direction === 'up' ? -delta : delta);
      return { success: true, output: `Scrolled ${direction} ${delta}px` };
    },

    wait: async ({ ms = 1000 }) => {
      const delay = typeof ms === 'number' ? Math.min(ms, 5000) : 1000;
      await new Promise(r => setTimeout(r, delay));
      return { success: true, output: `Waited ${delay}ms` };
    },
  };
}

export async function executeAction(
  action: AgentAction,
  page: Page,
  registry: ToolRegistry,
): Promise<ToolResult> {
  const handler = registry[action.action];
  if (!handler) return { success: false, output: '', error: `Unknown tool: ${action.action}` };

  try {
    return await handler(action.input, page);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn({ tool: action.action, input: action.input, err }, '[executor] Tool threw');
    return { success: false, output: '', error: msg };
  }
}
