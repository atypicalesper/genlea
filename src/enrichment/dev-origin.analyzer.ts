import axios from 'axios';
import { logger } from '../utils/logger.js';

export interface NameOriginResult {
  name: string;
  isIndianOrigin: boolean;
  confidence: number;
}

export interface RatioResult {
  indianCount: number;
  totalCount: number;
  ratio: number;
  reliable: boolean; // true if sample >= MIN_SAMPLE
}

const MIN_SAMPLE = parseInt(process.env['INDIAN_RATIO_MIN_SAMPLE'] ?? '10');
const ETHNICOLR_URL = process.env['ETHNICOLR_URL'] ?? 'http://localhost:5050';
const MIN_CONFIDENCE = 0.65;

export const indianRatioAnalyzer = {
  /**
   * Classify a batch of employee names and return the Indian dev ratio.
   * Calls the name-origin microservice at services/name-origin/
   */
  async analyzeNames(names: Array<{ firstName?: string; lastName?: string; fullName?: string }>): Promise<RatioResult> {
    if (names.length === 0) {
      return { indianCount: 0, totalCount: 0, ratio: 0, reliable: false };
    }

    try {
      const response = await axios.post<{
        results: NameOriginResult[];
        indian_count: number;
        total_count: number;
        ratio: number;
      }>(
        `${ETHNICOLR_URL}/classify/batch`,
        {
          names: names.map(n => ({
            first_name: n.firstName,
            last_name: n.lastName,
            full_name: n.fullName,
          })),
          min_confidence: MIN_CONFIDENCE,
        },
        { timeout: 15000 }
      );

      const { indian_count, total_count, ratio } = response.data;

      return {
        indianCount: indian_count,
        totalCount: total_count,
        ratio: parseFloat(ratio.toFixed(4)),
        reliable: total_count >= MIN_SAMPLE,
      };
    } catch (err) {
      logger.warn({ err }, 'Name origin service unavailable — using fallback');
      return this.fallbackAnalysis(names);
    }
  },

  /** Fallback: simple regex-based South Asian name detection */
  fallbackAnalysis(names: Array<{ firstName?: string; lastName?: string; fullName?: string }>): RatioResult {
    // Common South Asian syllable patterns in names
    const indianPattern = /\b(raj|ram|rav|pri|pra|san|sur|vik|vis|ash|amu|anv|dev|gan|har|jay|kal|man|nav|nih|nim|om|parag|roh|sar|shi|shan|sri|sub|suj|sun|tan|ume|uday|vij|vip|yog)\w*/i;
    const indianSurnamePattern = /\b(sharma|patel|gupta|singh|kumar|nair|rao|reddy|iyer|mehta|jain|shah|verma|mishra|kapoor|malhotra|chopra|agarwal|pillai|krishna|venkat|rajan)\b/i;

    let indianCount = 0;
    for (const n of names) {
      const fullName = n.fullName ?? `${n.firstName ?? ''} ${n.lastName ?? ''}`.trim();
      if (indianPattern.test(fullName) || indianSurnamePattern.test(fullName)) {
        indianCount++;
      }
    }

    const totalCount = names.length;
    return {
      indianCount,
      totalCount,
      ratio: totalCount > 0 ? parseFloat((indianCount / totalCount).toFixed(4)) : 0,
      reliable: totalCount >= MIN_SAMPLE,
    };
  },

  /** Check if the name origin service is reachable */
  async isServiceAvailable(): Promise<boolean> {
    try {
      const res = await axios.get(`${ETHNICOLR_URL}/health`, { timeout: 3000 });
      return res.status === 200;
    } catch {
      return false;
    }
  },
};
