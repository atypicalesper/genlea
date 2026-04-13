import { classifyWithGroq }    from './groq-classifier.js';
import { classifyWithPython }  from './ethnicolr-classifier.js';
import { classifyWithRegex }   from './regex-classifier.js';
import type { NameClassifier } from './types.js';

export { classifyWithGroq, classifyWithPython, classifyWithRegex };
export type { NameClassifier, NameInput, RatioResult } from './types.js';

export const NAME_CLASSIFIERS: NameClassifier[] = [
  {
    name:        'groq',
    isAvailable: () => !!process.env['GROQ_API_KEY'],
    classify:    classifyWithGroq,
  },
  {
    name:        'ethnicolr',
    isAvailable: () => true,
    classify:    classifyWithPython,
  },
  {
    name:        'regex',
    isAvailable: () => true,
    classify:    async names => classifyWithRegex(names),
  },
];
