import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { LeadStatus, LeadFilter } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export async function leadsRoutes(app: FastifyInstance) {

  // GET /api/leads — paginated, filterable list
  app.get<{ Querystring: LeadFilter }>('/leads', async (req, reply) => {
    const {
      status, minScore, techStack, fundingStage,
      hqState, source, page = 1, limit = 50,
    } = req.query;

    logger.info({ filters: req.query }, '[api:leads] GET /leads request');

    const filter: Record<string, unknown> = {};
    if (status)      filter['status'] = status;
    if (minScore)    filter['score'] = { $gte: Number(minScore) };
    if (fundingStage) filter['fundingStage'] = fundingStage;
    if (hqState)     filter['hqState'] = hqState;
    if (source)      filter['sources'] = { $in: [source] };
    if (techStack) {
      const tags = Array.isArray(techStack) ? techStack : [techStack];
      filter['techStack'] = { $in: tags };
    }

    const skip = (Number(page) - 1) * Number(limit);
    const [companies, total] = await Promise.all([
      companyRepository.findMany(filter, { sort: { score: -1 }, limit: Number(limit), skip }),
      companyRepository.count(filter),
    ]);

    logger.info({ total, returned: companies.length }, '[api:leads] Responding');
    return reply.send({
      success: true,
      data: companies,
      meta: { total, page: Number(page), limit: Number(limit), pages: Math.ceil(total / Number(limit)) },
    });
  });

  // GET /api/stats — dashboard summary counts
  app.get('/stats', async (_req, reply) => {
    logger.info('[api:leads] GET /stats request');
    const [total, hot, warm, cold, disqualified, pending] = await Promise.all([
      companyRepository.count(),
      companyRepository.count({ status: { $in: ['hot', 'hot_verified'] } }),
      companyRepository.count({ status: 'warm' }),
      companyRepository.count({ status: 'cold' }),
      companyRepository.count({ status: 'disqualified' }),
      companyRepository.count({ status: 'pending' }),
    ]);
    return reply.send({
      success: true,
      data: { total, hot, warm, cold, disqualified, pending },
    });
  });
}
