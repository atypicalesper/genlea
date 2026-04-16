const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions?/gi,
  /you\s+are\s+now\s+/gi,
  /<\|?system\|?>/gi,
  /\[INST\]/gi,
  /###\s*instruction/gi,
  /forget\s+(everything|all)/gi,
  /disregard\s+(all\s+)?previous/gi,
  /new\s+instructions?:/gi,
  /override\s+(all\s+)?previous/gi,
  /act\s+as\s+(a\s+)?(?:different|new|another)/gi,
];

/**
 * Strip control characters and known prompt-injection patterns from agent inputs.
 * Use on any free-text field before it enters an LLM context.
 */
export function sanitizeAgentInput(raw: string, maxLength = 500): string {
  if (typeof raw !== 'string') return '';

  let clean = raw
    .replace(/\0/g, '')
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');

  for (const pattern of INJECTION_PATTERNS) {
    clean = clean.replace(pattern, '');
  }

  return clean.trim().slice(0, maxLength);
}

export function isInjectionAttempt(input: string): boolean {
  return INJECTION_PATTERNS.some(p => {
    p.lastIndex = 0;
    return p.test(input);
  });
}
