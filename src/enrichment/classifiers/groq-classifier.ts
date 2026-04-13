import { z } from 'zod';
import { groq, GROQ_MODEL } from '../../utils/groq.client.js';
import { logger } from '../../utils/logger.js';
import type { NameInput, RatioResult } from './types.js';
import { MIN_CONFIDENCE, MIN_SAMPLE } from './types.js';

const GROQ_BATCH_SIZE = 50;

const GroqResponseSchema = z.object({
  results: z.array(z.object({
    index:      z.number(),
    isIndian:   z.boolean(),
    confidence: z.number().min(0).max(1),
  })),
});

export async function classifyWithGroq(names: NameInput[]): Promise<RatioResult> {
  const nameStrings = names.map(n =>
    (n.fullName ?? `${n.firstName ?? ''} ${n.lastName ?? ''}`).trim(),
  );

  let indianCount = 0;
  const totalCount = nameStrings.length;

  for (let i = 0; i < nameStrings.length; i += GROQ_BATCH_SIZE) {
    const batch    = nameStrings.slice(i, i + GROQ_BATCH_SIZE);
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
            `Use confidence >= ${MIN_CONFIDENCE} threshold. Include every name in the list.`,
        },
        { role: 'user', content: `Classify these names:\n${numbered}` },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? '{}';
    let jsonParsed: unknown;
    try {
      jsonParsed = JSON.parse(raw);
    } catch {
      logger.warn({ raw: raw.slice(0, 200) }, '[groq-classifier] Invalid JSON — skipping batch');
      continue;
    }

    const parsed = GroqResponseSchema.safeParse(jsonParsed);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues, raw: raw.slice(0, 200) }, '[groq-classifier] Schema validation failed — skipping batch');
      continue;
    }

    for (const r of parsed.data.results) {
      if (r.isIndian && r.confidence >= MIN_CONFIDENCE) indianCount++;
    }
  }

  return {
    indianCount,
    totalCount,
    ratio:    totalCount > 0 ? parseFloat((indianCount / totalCount).toFixed(4)) : 0,
    reliable: totalCount >= MIN_SAMPLE,
  };
}
