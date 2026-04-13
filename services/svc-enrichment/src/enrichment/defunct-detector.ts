export const DEFUNCT_PATTERNS: RegExp[] = [
  /domain\s+(is\s+)?for\s+sale/i,
  /this\s+domain\s+has\s+(expired|been\s+suspended)/i,
  /account\s+suspended/i,
  /parked\s+(free\s+)?by\s+/i,
  /buy\s+this\s+domain/i,
  /company\s+(has\s+)?(closed|shut\s+down|ceased\s+operations)/i,
  /we\s+(are\s+|have\s+)?shut(ting)?\s+down/i,
  /no\s+longer\s+in\s+(business|operation)/i,
];

export function isDefunct(html: string, text: string): boolean {
  return DEFUNCT_PATTERNS.some(re => re.test(html) || re.test(text));
}
