import { FastifyInstance } from 'fastify';
import { ObjectId } from 'mongodb';
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
  outreachReady?: string;
};

function shouldPushDisqualifiedToEnd(q: LeadQuery): boolean {
  const sortBy = q.sortBy ?? 'score';
  const sortDir = q.sortDir ?? 'desc';

  return !q.status
    && q.qualified !== 'false'
    && sortBy === 'score'
    && sortDir === 'desc';
}

function toApiCompany<T extends { _id?: { toString(): string } }>(doc: T): T & { _id: string } {
  return { ...doc, _id: doc._id?.toString() ?? '' };
}

function buildLeadsFilter(q: LeadQuery): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  const andClauses: Record<string, unknown>[] = [];

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
    andClauses.push({
      $or: [
      { name:   { $regex: escaped, $options: 'i' } },
      { domain: { $regex: escaped, $options: 'i' } },
      ],
    });
  }

  if (q.outreachReady === 'true') {
    filter['status'] = { $nin: ['disqualified', 'pending'] };
    filter['employeeCount'] = { ...(filter['employeeCount'] as Record<string, number> | undefined), $lte: 1000 };
    filter['hqCountry'] = { $nin: ['India', 'Unknown', 'IN'] };
    filter['openRoles.0'] = { $exists: true };
    andClauses.push({
      $or: [
        { originRatio: { $gt: 0 } },
        { originDevCount: { $gt: 0 } },
      ],
    });
  }

  if (andClauses.length > 0) {
    filter['$and'] = andClauses;
  }

  return filter;
}

const OUTREACH_CONTACT_ROLE_FILTER = [
  'CEO',
  'Founder',
  'Co-Founder',
  'CTO',
  'VP of Engineering',
  'VP Engineering',
  'Head of Engineering',
  'Director of Engineering',
  'Recruiter',
  'Head of Talent',
  'Talent Acquisition',
  'Head of People',
  'HR',
  'Head of HR',
  'VP of HR',
];

async function applyOutreachReadyContactFilter(filter: Record<string, unknown>, enabled?: string): Promise<Record<string, unknown>> {
  if (enabled !== 'true') return filter;

  const contactIds = await getCollection(COLLECTIONS.CONTACTS).distinct('companyId', {
    forOriginRatio: { $ne: true },
    role: { $in: OUTREACH_CONTACT_ROLE_FILTER },
    $or: [
      { email: { $exists: true, $ne: '' } },
      { linkedinUrl: { $exists: true, $ne: '' } },
    ],
  });

  const objectIds = contactIds.flatMap(id => {
    if (typeof id !== 'string') return [];
    try { return [new ObjectId(id)]; } catch { return []; }
  });

  filter['_id'] = objectIds.length > 0 ? { $in: objectIds } : { $in: [] };
  return filter;
}

export async function leadsRoutes(app: FastifyInstance) {

  // GET /api/leads — paginated, filterable, sortable list
  app.get<{ Querystring: LeadQuery }>('/leads', async (req, reply) => {
    const { page = 1, limit = 50, sortBy = 'score', sortDir = 'desc' } = req.query;
    logger.info({ filters: req.query }, '[api:leads] GET /leads request');

    const filter    = await applyOutreachReadyContactFilter(buildLeadsFilter(req.query), req.query.outreachReady);
    const sortField = VALID_SORT_FIELDS[sortBy] ?? 'score';
    const sortOrder = sortDir === 'asc' ? 1 : -1;
    const safeLimit = Math.min(Number(limit), 500);
    const skip      = (Number(page) - 1) * safeLimit;

    const [companies, total] = await Promise.all([
      shouldPushDisqualifiedToEnd(req.query)
        ? getCollection(COLLECTIONS.COMPANIES)
            .aggregate([
              { $match: filter },
              {
                $addFields: {
                  // Keep disqualified leads visible, but sink them below active leads
                  // in the default score-sorted listing so the main page stays actionable.
                  __disqualifiedRank: { $cond: [{ $eq: ['$status', 'disqualified'] }, 1, 0] },
                },
              },
              { $sort: { __disqualifiedRank: 1, [sortField]: sortOrder, _id: 1 } },
              { $skip: skip },
              { $limit: safeLimit },
              { $project: { __disqualifiedRank: 0 } },
            ])
            .toArray()
            .then(docs => docs.map(toApiCompany))
        : companyRepository.findMany(filter, { sort: { [sortField]: sortOrder }, limit: safeLimit, skip }),
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
