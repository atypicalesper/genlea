import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { getCollection, COLLECTIONS } from '../../storage/mongo.client.js';
import { LeadStatus, LeadFilter } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const VALID_SORT_FIELDS: Record<string, string> = {
  score: 'score', originRatio: 'originRatio', employeeCount: 'employeeCount',
  name: 'name', fundingStage: 'fundingStage', createdAt: 'createdAt',
};

type LeadQuery = LeadFilter & {
  search?: string;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  qualified?: string;
  maxScore?: string;
};

function buildLeadsFilter(q: LeadQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};

  if (q.qualified === 'true') {
    filter['status'] = { $in: ['hot_verified', 'hot', 'warm'] };
  } else if (q.qualified === 'false') {
    filter['status'] = { $in: ['cold', 'disqualified'] };
  } else if (q.status) {
    filter['status'] = q.status;
  }

  if (q.minScore || q.maxScore) {
    const scoreFilter: Record<string, number> = {};
    if (q.minScore) scoreFilter['$gte'] = Number(q.minScore);
    if (q.maxScore) scoreFilter['$lte'] = Number(q.maxScore);
    filter['score'] = scoreFilter;
  }
  if (q.fundingStage) filter['fundingStage'] = q.fundingStage;
  if (q.hqState)      filter['hqState'] = q.hqState;
  if (q.source)       filter['sources'] = { $in: [q.source] };
  if (q.techStack) {
    const tags = Array.isArray(q.techStack) ? q.techStack : [q.techStack];
    filter['techStack'] = { $in: tags };
  }
  if (q.search) {
    const escaped = q.search.slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter['$or'] = [
      { name:   { $regex: escaped, $options: 'i' } },
      { domain: { $regex: escaped, $options: 'i' } },
    ];
  }

  return filter;
}

export async function leadsRoutes(app: FastifyInstance) {

  // GET /api/leads — paginated, filterable, sortable list
  app.get<{ Querystring: LeadQuery }>('/leads', async (req, reply) => {
    const { page = 1, limit = 50, sortBy = 'score', sortDir = 'desc' } = req.query;
    logger.info({ filters: req.query }, '[api:leads] GET /leads request');

    const filter    = buildLeadsFilter(req.query);
    const sortField = VALID_SORT_FIELDS[sortBy] ?? 'score';
    const sortOrder = sortDir === 'asc' ? 1 : -1;
    const safeLimit = Math.min(Number(limit), 500);
    const skip      = (Number(page) - 1) * safeLimit;

    const [companies, total] = await Promise.all([
      companyRepository.findMany(filter, { sort: { [sortField]: sortOrder }, limit: safeLimit, skip }),
      companyRepository.count(filter),
    ]);

    logger.info({ total, returned: companies.length }, '[api:leads] Responding');
    return reply.send({
      success: true,
      data: companies,
      meta: { total, page: Number(page), limit: safeLimit, pages: Math.ceil(total / Math.max(safeLimit, 1)) },
    });
  });

  // GET /api/stats — dashboard summary counts (single aggregation, not 7 queries)
  app.get('/stats', async (_req, reply) => {
    logger.info('[api:leads] GET /stats request');
    const agg = await getCollection(COLLECTIONS.COMPANIES)
      .aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ])
      .toArray();

    const byStatus: Record<string, number> = {};
    let total = 0;
    for (const row of agg) {
      byStatus[row._id] = row.count;
      total += row.count;
    }

    return reply.send({
      success: true,
      data: {
        total,
        hot_verified: byStatus['hot_verified'] ?? 0,
        hot:          byStatus['hot']          ?? 0,
        warm:         byStatus['warm']         ?? 0,
        cold:         byStatus['cold']         ?? 0,
        disqualified: byStatus['disqualified'] ?? 0,
        pending:      byStatus['pending']      ?? 0,
      },
    });
  });
}
