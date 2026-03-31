import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { LeadStatus, LeadFilter } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

const VALID_SORT_FIELDS: Record<string, string> = {
  score: 'score', originRatio: 'originRatio', employeeCount: 'employeeCount',
  name: 'name', fundingStage: 'fundingStage', createdAt: 'createdAt',
};

export async function leadsRoutes(app: FastifyInstance) {

  // GET /api/leads — paginated, filterable, sortable list
  app.get<{
    Querystring: LeadFilter & {
      search?: string;
      sortBy?: string;
      sortDir?: 'asc' | 'desc';
      qualified?: string;
      maxScore?: string;
    }
  }>('/leads', async (req, reply) => {
    const {
      status, minScore, maxScore, techStack, fundingStage,
      hqState, source, page = 1, limit = 50,
      search, sortBy = 'score', sortDir = 'desc', qualified,
    } = req.query;

    logger.info({ filters: req.query }, '[api:leads] GET /leads request');

    const filter: Record<string, unknown> = {};

    // Qualified/disqualified segments
    if (qualified === 'true') {
      filter['status'] = { $in: ['hot_verified', 'hot', 'warm'] };
    } else if (qualified === 'false') {
      filter['status'] = { $in: ['cold', 'disqualified'] };
    } else if (status) {
      filter['status'] = status;
    }

    if (minScore || maxScore) {
      const scoreFilter: Record<string, number> = {};
      if (minScore) scoreFilter['$gte'] = Number(minScore);
      if (maxScore) scoreFilter['$lte'] = Number(maxScore);
      filter['score'] = scoreFilter;
    }
    if (fundingStage) filter['fundingStage'] = fundingStage;
    if (hqState)      filter['hqState'] = hqState;
    if (source)       filter['sources'] = { $in: [source] };
    if (techStack) {
      const tags = Array.isArray(techStack) ? techStack : [techStack];
      filter['techStack'] = { $in: tags };
    }
    if (search) {
      filter['$or'] = [
        { name:   { $regex: search, $options: 'i' } },
        { domain: { $regex: search, $options: 'i' } },
      ];
    }

    const sortField = VALID_SORT_FIELDS[sortBy] ?? 'score';
    const sortOrder = sortDir === 'asc' ? 1 : -1;

    const skip = (Number(page) - 1) * Number(limit);
    const [companies, total] = await Promise.all([
      companyRepository.findMany(filter, { sort: { [sortField]: sortOrder }, limit: Number(limit), skip }),
      companyRepository.count(filter),
    ]);

    logger.info({ total, returned: companies.length }, '[api:leads] Responding');
    return reply.send({
      success: true,
      data: companies,
      meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Math.max(Number(limit), 1)) },
    });
  });

  // GET /api/stats — dashboard summary counts
  app.get('/stats', async (_req, reply) => {
    logger.info('[api:leads] GET /stats request');
    const [total, hot_verified, hot, warm, cold, disqualified, pending] = await Promise.all([
      companyRepository.count(),
      companyRepository.count({ status: 'hot_verified' }),
      companyRepository.count({ status: 'hot' }),
      companyRepository.count({ status: 'warm' }),
      companyRepository.count({ status: 'cold' }),
      companyRepository.count({ status: 'disqualified' }),
      companyRepository.count({ status: 'pending' }),
    ]);
    return reply.send({
      success: true,
      data: { total, hot_verified, hot, warm, cold, disqualified, pending },
    });
  });
}
