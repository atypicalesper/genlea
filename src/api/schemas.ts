import { z } from 'zod';
import type { FastifyReply, FastifyRequest } from 'fastify';

const LEAD_STATUSES = ['hot_verified', 'hot', 'warm', 'cold', 'disqualified', 'pending'] as const;
const SCRAPER_SOURCES = [
  'linkedin', 'crunchbase', 'apollo', 'wellfound',
  'indeed', 'glassdoor', 'zoominfo', 'surelyremote',
  'explorium', 'clay', 'greenhouse', 'lever', 'ashby', 'workable',
] as const;
const QUEUE_NAMES = ['discovery', 'enrichment', 'scoring'] as const;

const objectIdRegex = /^[0-9a-fA-F]{24}$/;

export const objectIdParam = z.object({
  id: z.string().regex(objectIdRegex, 'Invalid id format (expected 24-char hex ObjectId)'),
});

export const leadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
  sortBy: z.enum(['score', 'originRatio', 'employeeCount', 'name', 'fundingStage', 'createdAt']).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().max(200).optional(),
  status: z.enum(LEAD_STATUSES).optional(),
  qualified: z.enum(['true', 'false']).optional(),
  outreachReady: z.enum(['true', 'false']).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
  maxScore: z.coerce.number().int().min(0).max(100).optional(),
  fundingStage: z.string().max(50).optional(),
  hqState: z.string().max(50).optional(),
  source: z.string().max(50).optional(),
  techStack: z.union([z.string().max(100), z.array(z.string().max(100)).max(50)]).optional(),
});

export const exportCsvQuerySchema = z.object({
  status: z.enum(LEAD_STATUSES).optional(),
  minScore: z.coerce.number().int().min(0).max(100).optional(),
});

export const patchCompanyBodySchema = z.object({
  name: z.string().trim().min(2).max(200).optional(),
  notes: z.string().max(2000).optional(),
}).refine(b => b.name !== undefined || b.notes !== undefined, {
  message: 'At least one of name or notes is required',
});

export const patchCompanyStatusBodySchema = z.object({
  status: z.enum(LEAD_STATUSES),
  reason: z.string().max(500).optional(),
});

export const contactsForCompaniesQuerySchema = z.object({
  ids: z.string().max(5_000).optional(),
});

export const scrapeBodySchema = z.object({
  source: z.enum(SCRAPER_SOURCES),
  query: z.object({
    keywords: z.string().min(1).max(500),
    location: z.string().max(200).optional(),
    techStack: z.array(z.string().max(50)).max(30).optional(),
    companySize: z.tuple([z.number().int(), z.number().int()]).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  limit: z.number().int().min(1).max(200).optional(),
});

export const queueParamSchema = z.object({
  queue: z.enum(QUEUE_NAMES),
});

export const jobLogsQuerySchema = z.object({
  scraper: z.string().max(50).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

const settingsNumericFields = z.object({
  originRatioThreshold: z.number().min(0).max(1).optional(),
  originRatioMinSample: z.number().int().min(1).max(1000).optional(),
  leadScoreHotVerifiedThreshold: z.number().int().min(0).max(100).optional(),
  leadScoreHotThreshold: z.number().int().min(0).max(100).optional(),
  leadScoreWarmThreshold: z.number().int().min(0).max(100).optional(),
  leadScoreColdThreshold: z.number().int().min(0).max(100).optional(),
  workerConcurrencyDiscovery: z.number().int().min(1).max(50).optional(),
  workerConcurrencyEnrichment: z.number().int().min(1).max(50).optional(),
  workerConcurrencyScoring: z.number().int().min(1).max(50).optional(),
  maxConcurrentBrowsers: z.number().int().min(1).max(20).optional(),
});

export const settingsBodySchema = settingsNumericFields.extend({
  targetTechTags: z.array(z.string().min(1).max(50)).max(100).optional(),
  highValueIndustries: z.array(z.string().min(1).max(100)).max(100).optional(),
});

export const domainParamSchema = z.object({
  domain: z.string().min(3).max(253).regex(/^[a-zA-Z0-9.-]+$/, 'Invalid domain format'),
});

/**
 * Generic helper that validates a Zod schema against a request part and
 * sends a 400 with a structured error if validation fails. Returns the
 * parsed value, or `null` if a response was already sent.
 */
export function parseOrReply<T extends z.ZodTypeAny>(
  schema: T,
  data: unknown,
  reply: FastifyReply,
  field: 'query' | 'body' | 'params' = 'body',
): z.infer<T> | null {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  reply.status(400).send({
    success: false,
    error: `Invalid ${field}`,
    issues: result.error.issues.map(i => ({ path: i.path.join('.'), message: i.message })),
  });
  return null;
}

export function parseQuery<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply) {
  return parseOrReply(schema, req.query, reply, 'query');
}
export function parseBody<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply) {
  return parseOrReply(schema, req.body, reply, 'body');
}
export function parseParams<T extends z.ZodTypeAny>(schema: T, req: FastifyRequest, reply: FastifyReply) {
  return parseOrReply(schema, req.params, reply, 'params');
}
