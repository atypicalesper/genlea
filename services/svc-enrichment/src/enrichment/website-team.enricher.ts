import axios from 'axios';
import { logger } from '@genlea/shared';

/**
 * Website team page scraper.
 * Scrapes /team, /about, /about-us, /people pages on the company's own website.
 * Free — no API key. Finds employee names + emails for origin ratio and contacts.
 *
 * Returns: array of { fullName, email?, linkedinUrl? }
 */

const TEAM_PATHS = [
  '/team', '/about', '/about-us', '/people', '/company/team',
  '/who-we-are', '/our-team', '/meet-the-team', '/staff',
];

const HTTP_OPTS = {
  timeout: 8000,
  maxRedirects: 3,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml',
    'Accept-Language': 'en-US,en;q=0.9',
  },
};

export interface WebsitePerson {
  fullName:    string;
  role?:       string;
  email?:      string;
  phone?:      string;
  linkedinUrl?: string;
}

export const websiteTeamScraper = {
  async scrapeTeam(websiteUrl: string, domain: string): Promise<WebsitePerson[]> {
    const base = websiteUrl.replace(/\/$/, '');
    const found = new Map<string, WebsitePerson>(); // keyed by fullName

    for (const path of TEAM_PATHS) {
      try {
        const url = base + path;
        const res = await axios.get<string>(url, HTTP_OPTS);
        const html = res.data;

        if (typeof html !== 'string' || html.length < 200) continue;

        // Extract mailto: emails
        const emailMatches = [...html.matchAll(/mailto:([a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,})/gi)];
        const domainEmails = emailMatches
          .map(m => m[1]!.toLowerCase())
          .filter(e => e.endsWith(`@${domain}`) || e.endsWith(`.${domain}`));

        // Extract phone numbers from visible text
        const textContent = html.replace(/<[^>]+>/g, ' ');
        const phoneMatches = [...textContent.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\+\d{1,3}[-.\s]\d{2,4}[-.\s]\d{3,4}[-.\s]\d{3,4}/g)]
          .map(m => m[0]!.trim());

        // Extract names + LinkedIn + role from anchor tags around LinkedIn profile links
        // Pattern: <a href="https://linkedin.com/in/slug">Name Here</a>
        const liMatches = [...html.matchAll(/<a[^>]+href=["']https?:\/\/(?:www\.)?linkedin\.com\/in\/([^/"']+)[^>]*>([^<]{3,60})<\/a>/gi)];
        for (const m of liMatches) {
          const slug        = m[1]!;
          const nameRaw     = m[2]!.trim().replace(/\s+/g, ' ');
          const linkedinUrl = `https://linkedin.com/in/${slug}`;

          if (/follow|connect|view|profile|linkedin|click|here/i.test(nameRaw)) continue;
          if (!looksLikeName(nameRaw)) continue;

          const key = nameRaw.toLowerCase();
          if (!found.has(key)) found.set(key, { fullName: nameRaw, linkedinUrl });
          else found.get(key)!.linkedinUrl = linkedinUrl;

          // Look for role/title in surrounding 400 chars
          const matchIdx = m.index ?? 0;
          const ctx = html.slice(Math.max(0, matchIdx - 400), matchIdx + 400)
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const roleMatch = ctx.match(/\b(CEO|CTO|COO|CFO|CPO|Founder|Co-?Founder|Head of [\w ]{3,30}|VP(?: of)? [\w ]{3,25}|Director of [\w ]{3,25}|Engineering Manager|Product Manager|Recruiter|Talent|Head of HR|HR)\b/i);
          if (roleMatch && !found.get(key)!.role) found.get(key)!.role = roleMatch[0]!.trim();
        }

        // Extract names from structured name patterns in headings near team sections
        const headingMatches = [...html.matchAll(/<h[234][^>]*>\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\s*<\/h[234]>/g)];
        for (const m of headingMatches) {
          const nameRaw = m[1]!.trim();
          if (!looksLikeName(nameRaw)) continue;
          const key = nameRaw.toLowerCase();
          if (!found.has(key)) found.set(key, { fullName: nameRaw });

          // Look for role in the 300 chars after the heading
          const matchIdx = m.index ?? 0;
          const ctx = html.slice(matchIdx, matchIdx + 300)
            .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
          const roleMatch = ctx.match(/\b(CEO|CTO|COO|CFO|CPO|Founder|Co-?Founder|Head of [\w ]{3,30}|VP(?: of)? [\w ]{3,25}|Director of [\w ]{3,25}|Engineering Manager|Product Manager|Recruiter|Talent|Head of HR|HR)\b/i);
          if (roleMatch && !found.get(key)!.role) found.get(key)!.role = roleMatch[0]!.trim();
        }

        // Attach domain emails to people by name-prefix matching
        for (const email of domainEmails) {
          const prefix = email.split('@')[0]!.replace(/[._-]/g, ' ').toLowerCase();
          for (const [key, person] of found) {
            if (!person.email && key.includes(prefix.split(' ')[0]!)) {
              person.email = email;
              break;
            }
          }
        }

        // Attach a single phone number to people when there's only one (likely the contact's)
        if (phoneMatches.length === 1) {
          for (const person of found.values()) {
            if (!person.phone) { person.phone = phoneMatches[0]; break; }
          }
        }

        if (found.size > 0) {
          logger.info(
            { domain, path, found: found.size },
            '[website.scraper] Team members found'
          );
          break; // stop at first successful path
        }
      } catch (err) {
        // 404s, redirects, timeouts are expected — log anything unexpected
        if (axios.isAxiosError(err) && (err.response?.status ?? 0) >= 500) {
          logger.debug({ err, domain, path }, '[website.scraper] Server error on team page — trying next path');
        }
      }
    }

    return [...found.values()].slice(0, 50); // cap at 50
  },
};

function looksLikeName(text: string): boolean {
  // 2–4 words, each starting with uppercase, mostly letters, no URLs or special chars
  if (!/^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/.test(text)) return false;
  if (/https?:|www\.|\.com|@/.test(text)) return false;
  // Not a generic heading
  if (/^(About|Team|People|Meet|Our|The|Company|Contact|Join|Career)/i.test(text)) return false;
  return true;
}
