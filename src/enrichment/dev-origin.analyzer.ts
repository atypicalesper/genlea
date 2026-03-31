import axios from 'axios';
import { z } from 'zod';
import { logger } from '../utils/logger.js';
import { groq, GROQ_MODEL } from '../utils/groq.client.js';

const GroqResponseSchema = z.object({
  results: z.array(z.object({
    index:      z.number(),
    isIndian:   z.boolean(),
    confidence: z.number().min(0).max(1),
  })),
});

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

type NameInput = { firstName?: string; lastName?: string; fullName?: string };

const MIN_SAMPLE    = parseInt(process.env['INDIAN_RATIO_MIN_SAMPLE'] ?? '10');
const ETHNICOLR_URL = process.env['ETHNICOLR_URL'] ?? 'http://localhost:5050';
const MIN_CONFIDENCE = 0.65;

// Groq batch size — keep prompts short to stay within token limits
const GROQ_BATCH_SIZE = 50;

// ── Groq classification ────────────────────────────────────────────────────────

async function classifyWithGroq(names: NameInput[]): Promise<RatioResult> {
  const nameStrings = names.map(n =>
    (n.fullName ?? `${n.firstName ?? ''} ${n.lastName ?? ''}`).trim()
  );

  let indianCount = 0;
  const totalCount = nameStrings.length;

  // Process in batches
  for (let i = 0; i < nameStrings.length; i += GROQ_BATCH_SIZE) {
    const batch = nameStrings.slice(i, i + GROQ_BATCH_SIZE);
    const numbered = batch.map((name, idx) => `${i + idx + 1}. ${name}`).join('\n');

    const response = await groq.chat.completions.create({
      model: GROQ_MODEL,
      temperature: 0,
      max_tokens: 512,
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content:
            'You are a name-origin classifier. Given a list of names, determine which are of Indian/South-Asian origin. ' +
            'Respond ONLY with a JSON object: { "results": [ { "index": 1, "isIndian": true/false, "confidence": 0.0-1.0 }, ... ] }. ' +
            'Use confidence >= 0.65 threshold. Include every name in the list.',
        },
        {
          role: 'user',
          content: `Classify these names:\n${numbered}`,
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, '[dev-origin] Groq returned invalid JSON — skipping batch');
      continue;
    }

    const parsed = GroqResponseSchema.safeParse(jsonParsed);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues, raw: raw.slice(0, 200) }, '[dev-origin] Groq response failed schema validation — skipping batch');
      continue;
    }

    for (const r of parsed.data.results) {
      if (r.isIndian && r.confidence >= MIN_CONFIDENCE) {
        indianCount++;
      }
    }
  }

  return {
    indianCount,
    totalCount,
    ratio: totalCount > 0 ? parseFloat((indianCount / totalCount).toFixed(4)) : 0,
    reliable: totalCount >= MIN_SAMPLE,
  };
}

// ── Python microservice fallback ───────────────────────────────────────────────

async function classifyWithPython(names: NameInput[]): Promise<RatioResult> {
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
    { timeout: 15000 }
  );

  const { indian_count, total_count, ratio } = response.data;
  return {
    indianCount: indian_count,
    totalCount:  total_count,
    ratio:       parseFloat(ratio.toFixed(4)),
    reliable:    total_count >= MIN_SAMPLE,
  };
}

// ── Regex last-resort fallback ─────────────────────────────────────────────────

function classifyWithRegex(names: NameInput[]): RatioResult {
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
}

// ── Strategy pattern — ordered list of name classifiers ───────────────────────

interface NameClassifier {
  name:        string;
  isAvailable: () => boolean;
  classify:    (names: NameInput[]) => Promise<RatioResult>;
}

const NAME_CLASSIFIERS: NameClassifier[] = [
  {
    name:        'groq',
    isAvailable: () => !!process.env['GROQ_API_KEY'],
    classify:    classifyWithGroq,
  },
  {
    name:        'ethnicolr',
    isAvailable: () => true, // always attempt; classify() throws on failure
    classify:    classifyWithPython,
  },
  {
    name:        'regex',
    isAvailable: () => true,
    classify:    async (names) => classifyWithRegex(names),
  },
];

// ── Public analyzer ────────────────────────────────────────────────────────────

export const indianRatioAnalyzer = {
  async analyzeNames(names: NameInput[]): Promise<RatioResult> {
    if (names.length === 0) {
      return { indianCount: 0, totalCount: 0, ratio: 0, reliable: false };
    }

    for (const classifier of NAME_CLASSIFIERS) {
      if (!classifier.isAvailable()) continue;
      try {
        const result = await classifier.classify(names);
        logger.info(
          { provider: classifier.name, total: result.totalCount, indian: result.indianCount },
          '[dev-origin] Classification complete'
        );
        return result;
      } catch (err) {
        logger.warn({ err, provider: classifier.name }, `[dev-origin] ${classifier.name} failed — trying next provider`);
      }
    }

    // Should never reach here — regex never throws
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
