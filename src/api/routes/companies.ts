import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { jobRepository } from '../../storage/repositories/job.repository.js';
import { queueManager } from '../../core/queue.manager.js';
import { generateRunId } from '../../utils/random.js';
import { LeadStatus } from '../../types/index.js';
import { logger } from '../../utils/logger.js';

export async function companiesRoutes(app: FastifyInstance) {

  // GET /api/companies/:id — full company profile with contacts + jobs
  app.get<{ Params: { id: string } }>('/companies/:id', async (req, reply) => {
    const { id } = req.params;
    logger.info({ id }, '[api:companies] GET /companies/:id');

    const [company, contacts, jobs] = await Promise.all([
      companyRepository.findById(id),
      contactRepository.findByCompanyId(id),
      jobRepository.findByCompanyId(id, false), // include inactive
    ]);

    if (!company) {
      logger.warn({ id }, '[api:companies] Not found');
      return reply.status(404).send({ success: false, error: 'Company not found' });
    }

    const ceo   = contacts.find(c => ['CEO', 'Founder'].includes(c.role));
    const cto   = contacts.find(c => c.role === 'CTO');
    const hr    = contacts.find(c => ['HR', 'Recruiter', 'Head of Talent'].includes(c.role));
    const other = contacts.filter(c => !['CEO', 'Founder', 'CTO', 'HR', 'Recruiter', 'Head of Talent'].includes(c.role));

    const activeJobs   = jobs.filter(j => j.isActive);
    const inactiveJobs = jobs.filter(j => !j.isActive);

    logger.info(
      { id, domain: company.domain, contacts: contacts.length, jobs: jobs.length },
      '[api:companies] Company found'
    );

    return reply.send({
      success: true,
      data: {
        company,
        contacts: {
          ceo: ceo ?? null,
          cto: cto ?? null,
          hr:  hr  ?? null,
          other,
        },
        jobs: {
          active:   activeJobs,
          inactive: inactiveJobs,
        },
        summary: {
          totalContacts:  contacts.length,
          verifiedEmails: contacts.filter(c => c.emailVerified).length,
          activeJobs:     activeJobs.length,
          score:          company.score,
          status:         company.status,
          originRatio:    company.originRatio,
        },
      },
    });
  });

  // GET /api/companies/domain/:domain — look up by domain instead of _id
  app.get<{ Params: { domain: string } }>('/companies/domain/:domain', async (req, reply) => {
    const { domain } = req.params;
    logger.info({ domain }, '[api:companies] GET /companies/domain/:domain');

    const company = await companyRepository.findByDomain(domain);
    if (!company) {
      return reply.status(404).send({ success: false, error: `No company found for domain: ${domain}` });
    }

    const contacts = await contactRepository.findByCompanyId(company._id!);
    return reply.send({ success: true, data: { company, contacts } });
  });

  // DELETE /api/companies/:id — remove company + its contacts + jobs
  app.delete<{ Params: { id: string } }>('/companies/:id', async (req, reply) => {
    const { id } = req.params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    await Promise.all([
      companyRepository.deleteOne(id),
      contactRepository.deleteByCompanyId(id),
      jobRepository.deleteByCompanyId(id),
    ]);
    logger.info({ id, domain: company.domain }, '[api:companies] Company deleted');
    return reply.send({ success: true });
  });

  // PATCH /api/companies/:id/status — manually override lead status
  app.patch<{ Params: { id: string }; Body: { status: LeadStatus } }>(
    '/companies/:id/status',
    async (req, reply) => {
      const { id } = req.params;
      const { status } = req.body;
      const validStatuses: LeadStatus[] = ['hot_verified', 'hot', 'warm', 'cold', 'disqualified', 'pending'];
      if (!validStatuses.includes(status)) {
        return reply.status(400).send({ success: false, error: 'Invalid status' });
      }
      const company = await companyRepository.findById(id);
      if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

      await companyRepository.upsert({ domain: company.domain, name: company.name, status, manuallyReviewed: true });
      logger.info({ id, domain: company.domain, status }, '[api:companies] Status overridden');
      return reply.send({ success: true, data: { status } });
    }
  );

  // POST /api/companies/:id/enrich — re-queue enrichment for a company
  app.post<{ Params: { id: string } }>('/companies/:id/enrich', async (req, reply) => {
    const { id } = req.params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    const runId = generateRunId();
    await queueManager.addEnrichmentJob({ runId, companyId: id, domain: company.domain, sources: ['github', 'hunter', 'clearbit'] });
    logger.info({ id, domain: company.domain, runId }, '[api:companies] Re-enrichment queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  // POST /api/companies/:id/score — re-queue scoring for a company
  app.post<{ Params: { id: string } }>('/companies/:id/score', async (req, reply) => {
    const { id } = req.params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    const runId = generateRunId();
    await queueManager.addScoringJob({ runId, companyId: id });
    logger.info({ id, domain: company.domain, runId }, '[api:companies] Re-scoring queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  // GET /api/companies — same as /leads but grouped — alias for convenience
  app.get('/companies', async (req, reply) => {
    return reply.redirect('/api/leads');
  });
}
