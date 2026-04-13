import type { NameInput, RatioResult } from './types.js';
import { MIN_SAMPLE } from './types.js';

const INDIAN_FIRST_NAME = /\b(raj|ram|rav|pri|pra|san|sur|vik|vis|ash|amu|anv|dev|gan|har|jay|kal|man|nav|nih|nim|om|parag|roh|sar|shi|shan|sri|sub|suj|sun|tan|ume|uday|vij|vip|yog)\w*/i;
const INDIAN_SURNAME    = /\b(sharma|patel|gupta|singh|kumar|nair|rao|reddy|iyer|mehta|jain|shah|verma|mishra|kapoor|malhotra|chopra|agarwal|pillai|krishna|venkat|rajan)\b/i;

export function classifyWithRegex(names: NameInput[]): RatioResult {
  let indianCount = 0;
  for (const n of names) {
    const fullName = n.fullName ?? `${n.firstName ?? ''} ${n.lastName ?? ''}`.trim();
    if (INDIAN_FIRST_NAME.test(fullName) || INDIAN_SURNAME.test(fullName)) indianCount++;
  }
  const totalCount = names.length;
  return {
    indianCount,
    totalCount,
    ratio:    totalCount > 0 ? parseFloat((indianCount / totalCount).toFixed(4)) : 0,
    reliable: totalCount >= MIN_SAMPLE,
  };
}
