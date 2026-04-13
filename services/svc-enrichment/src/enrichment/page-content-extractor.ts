export type PersonCandidate = {
  name: string;
  role?: string;
  email?: string;
  phone?: string;
  linkedin?: string;
};

export type PageExtractResult = {
  people: PersonCandidate[];
  emails: string[];
  phones: string[];
  techKeywords: string[];
};

const TECH_KEYWORDS = [
  'react','vue','angular','node','nodejs','python','django','flask','fastapi',
  'ruby','rails','golang','go','java','spring','kotlin','swift','typescript','nextjs','nestjs',
  'aws','gcp','azure','docker','kubernetes','postgres','mongodb','redis','graphql','rust','elixir',
];

export function extractPeopleFromPage(html: string, text: string, domain: string): PageExtractResult {
  const candidates = new Map<string, PersonCandidate>();

  // JSON-LD Person schema
  const jsonldBlocks = [...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const block of jsonldBlocks) {
    try {
      const parsed = JSON.parse(block[1]!);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const people: Array<{ name?: string; email?: string; telephone?: string; url?: string; jobTitle?: string }> = [];
        if (item['@type'] === 'Person') people.push(item);
        if (item['@type'] === 'Organization' && Array.isArray(item.employee)) {
          people.push(...item.employee.filter((e: { '@type'?: string }) => e['@type'] === 'Person'));
        }
        for (const p of people) {
          if (!p.name) continue;
          candidates.set(p.name.toLowerCase(), {
            name:     p.name,
            role:     p.jobTitle,
            email:    p.email,
            phone:    p.telephone,
            linkedin: p.url?.includes('linkedin.com') ? p.url : undefined,
          });
        }
      }
    } catch { /* ignore malformed JSON-LD */ }
  }

  // LinkedIn anchor extraction
  const liMatches = [...html.matchAll(/<a[^>]+href=["'](https?:\/\/(?:www\.)?linkedin\.com\/in\/[^/"']+)[^>]*>([^<]{3,60})<\/a>/gi)];
  for (const m of liMatches) {
    const liUrl   = m[1]!;
    const nameRaw = m[2]!.trim().replace(/\s+/g, ' ');
    if (/follow|connect|view|profile|linkedin|click|here|share/i.test(nameRaw)) continue;
    if (!/^[A-Z][a-zA-Z'-]+(?:\s+[A-Z][a-zA-Z'-]+){1,3}$/.test(nameRaw)) continue;
    const key = nameRaw.toLowerCase();
    if (!candidates.has(key)) candidates.set(key, { name: nameRaw });
    candidates.get(key)!.linkedin = liUrl;
    const matchIdx = (m as RegExpMatchArray & { index?: number }).index ?? 0;
    const ctx = html.slice(Math.max(0, matchIdx - 400), matchIdx + 400);
    const ctxText = ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const roleMatch = ctxText.match(/\b(CEO|CTO|COO|CFO|CPO|Founder|Co-?Founder|Head of [\w ]{3,30}|VP(?: of)? [\w ]{3,25}|Director of [\w ]{3,25}|Engineering Manager|Product Manager|Recruiter|Talent|HR)\b/i);
    if (roleMatch && !candidates.get(key)!.role) candidates.get(key)!.role = roleMatch[0];
  }

  // Domain emails
  const allEmails = [...html.matchAll(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g)]
    .map(m => m[0]!.toLowerCase())
    .filter(e => e.endsWith('@' + domain) || e.endsWith('.' + domain));

  for (const email of allEmails) {
    const prefix = email.split('@')[0]!.replace(/[._\-]/g, ' ').toLowerCase();
    let matched = false;
    for (const [key, cand] of candidates) {
      if (!cand.email && (key.startsWith(prefix) || prefix.startsWith(key.split(' ')[0]!))) {
        cand.email = email; matched = true; break;
      }
    }
    if (!matched) candidates.set(`__email_${email}`, { name: '', email });
  }

  const phones = [...new Set(
    [...text.matchAll(/(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}|\+\d{1,3}[-.\s]\d{2,4}[-.\s]\d{3,4}[-.\s]\d{3,4}/g)]
      .map(m => m[0]!.trim()),
  )].slice(0, 10);

  const techKeywords = TECH_KEYWORDS.filter(kw => text.toLowerCase().includes(kw));

  return {
    people:       [...candidates.values()].filter(p => p.name && p.name.length > 1),
    emails:       [...new Set(allEmails)],
    phones,
    techKeywords: [...new Set(techKeywords)],
  };
}
