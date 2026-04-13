import axios from 'axios';
import { logger } from '../utils/logger.js';
import { NAME_CLASSIFIERS } from './classifiers/index.js';
import { ETHNICOLR_URL } from './classifiers/types.js';

export interface NameOriginResult {
  name: string;
  isIndianOrigin: boolean;
  confidence: number;
}

export type { RatioResult } from './classifiers/types.js';

export const indianRatioAnalyzer = {
  async analyzeNames(names: Array<{ firstName?: string; lastName?: string; fullName?: string }>): Promise<import('./classifiers/types.js').RatioResult> {
    if (names.length === 0) {
      return { indianCount: 0, totalCount: 0, ratio: 0, reliable: false };
    }

    for (const classifier of NAME_CLASSIFIERS) {
      if (!classifier.isAvailable()) continue;
      try {
        const result = await classifier.classify(names);
        logger.info(
          { provider: classifier.name, total: result.totalCount, indian: result.indianCount },
          '[dev-origin] Classification complete',
        );
        return result;
      } catch (err) {
        logger.warn({ err, provider: classifier.name }, `[dev-origin] ${classifier.name} failed — trying next provider`);
      }
    }

    logger.error('[dev-origin] All classifiers failed — returning zero result');
    return { indianCount: 0, totalCount: names.length, ratio: 0, reliable: false };
  },

  async isServiceAvailable(): Promise<boolean> {
    if (process.env['GROQ_API_KEY']) return true;
    try {
      const res = await axios.get(`${ETHNICOLR_URL}/health`, { timeout: 3000 });
      return res.status === 200;
    } catch {
      return false;
    }
  },
};
