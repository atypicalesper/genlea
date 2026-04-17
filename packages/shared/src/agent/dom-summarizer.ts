/// <reference lib="dom" />
import type { Page } from 'playwright';

export interface DomInput {
  selector: string;
  placeholder?: string;
  type?: string;
}

export interface DomLink {
  text: string;
  href: string;
}

export interface DomSummary {
  url:      string;
  title:    string;
  buttons:  string[];
  inputs:   DomInput[];
  links:    DomLink[];
  headings: string[];
  text:     string;
}

// Runs inside the browser context — no Node imports allowed in this fn.
export async function summarizeDom(page: Page, maxTextLength = 800): Promise<DomSummary> {
  return page.evaluate((maxLen: number): DomSummary => {
    const clean = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 200);

    const buttons = Array.from(
      document.querySelectorAll<HTMLElement>('button, [role="button"], input[type="submit"], input[type="button"]'),
    )
      .map(el => clean(el.textContent ?? (el as HTMLInputElement).value ?? ''))
      .filter(Boolean)
      .slice(0, 10);

    const inputs = Array.from(document.querySelectorAll<HTMLInputElement>('input:not([type="hidden"]), textarea'))
      .map(el => {
        const label = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent?.trim() : undefined;
        const selector =
          el.id          ? `#${el.id}` :
          el.name        ? `[name="${el.name}"]` :
          el.placeholder ? `[placeholder="${el.placeholder}"]` : '';
        return { selector, placeholder: el.placeholder || label || '', type: el.type };
      })
      .filter(i => i.selector)
      .slice(0, 8);

    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('a[href]'))
      .map(a => ({ text: clean(a.textContent ?? ''), href: a.href }))
      .filter(l => l.text)
      .slice(0, 15);

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4'))
      .map(h => clean(h.textContent ?? ''))
      .filter(Boolean)
      .slice(0, 8);

    const text = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim().slice(0, maxLen);

    return { url: location.href, title: document.title, buttons, inputs, links, headings, text };
  }, maxTextLength);
}
