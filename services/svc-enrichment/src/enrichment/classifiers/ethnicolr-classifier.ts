import axios from 'axios';
import type { NameInput, RatioResult } from './types.js';
import { MIN_CONFIDENCE, MIN_SAMPLE, ETHNICOLR_URL } from './types.js';
import type { NameOriginResult } from '../dev-origin.analyzer.js';

export async function classifyWithPython(names: NameInput[]): Promise<RatioResult> {
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
        last_name:  n.lastName,
        full_name:  n.fullName,
      })),
      min_confidence: MIN_CONFIDENCE,
    },
    { timeout: 15000 },
  );

  const { indian_count, total_count, ratio } = response.data;
  return {
    indianCount: indian_count,
    totalCount:  total_count,
    ratio:       parseFloat(ratio.toFixed(4)),
    reliable:    total_count >= MIN_SAMPLE,
  };
}
