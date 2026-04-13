import { FastifyInstance } from 'fastify';
import {
  companyRepository,
  contactRepository,
  jobRepository,
  queueManager,
  generateRunId,
  logger,
} from '@genlea/shared';
import type { Contact, LeadStatus } from '@genlea/shared';

const CONTACT_ROLE_ORDER: Record<string, number> = {
  'CEO': 0, 'Founder': 1, 'Co-Founder': 2, 'CTO': 3,
  'VP of Engineering': 4, 'VP Engineering': 4, 'Head of Engineering': 5,
  'Director of Engineering': 6, 'Engineering Manager': 7, 'CPO': 8, 'COO': 9, 'CFO': 10,
  'Head of HR': 11, 'VP of HR': 11, 'HR': 12, 'Recruiter': 13,
  'Head of Talent': 14, 'Talent Acquisition': 15, 'Unknown': 99,
};

function sortContactsByRole(contacts: Contact[]): Contact[] {
  return [...contacts].sort((a, b) =>
    (CONTACT_ROLE_ORDER[a.role] ?? 50) - (CONTACT_ROLE_ORDER[b.role] ?? 50)
  );
}

export async function companiesRoutes(app: FastifyInstance) {

  app.get<{ Params: { id: string } }>('/companies/:id', async (req, reply) => {
    const { id } = req.params;
    const [company, contacts, jobs] = await Promise.all([
      companyRepository.findById(id),
      contactRepository.findByCompanyId(id),
      jobRepository.findByCompanyId(id, false),
    ]);

    if (!company) {
      return reply.status(404).send({ success: false, error: 'Company not found' });
    }

    const activeJobs   = jobs.filter(j => j.isActive);
    const inactiveJobs = jobs.filter(j => !j.isActive);

    return reply.send({
      success: true,
      data: {
        company,
        contacts: sortContactsByRole(contacts),
        jobs: { active: activeJobs, inactive: inactiveJobs },
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

  app.get<{ Params: { domain: string } }>('/companies/domain/:domain', async (req, reply) => {
    const company = await companyRepository.findByDomain(req.params.domain);
    if (!company) {
      return reply.status(404).send({ success: false, error: `No company found for domain: ${req.params.domain}` });
    }
    const contacts = await contactRepository.findByCompanyId(company._id!);
    return reply.send({ success: true, data: { company, contacts } });
  });

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

  app.post<{ Params: { id: string } }>('/companies/:id/enrich', async (req, reply) => {
    const { id } = req.params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    const runId = generateRunId();
    await queueManager.addEnrichmentJob({ runId, companyId: id, domain: company.domain, force: true });
    logger.info({ id, domain: company.domain, runId }, '[api:companies] Re-enrichment queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  app.post<{ Params: { id: string } }>('/companies/:id/score', async (req, reply) => {
    const { id } = req.params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    const runId = generateRunId();
    await queueManager.addScoringJob({ runId, companyId: id });
    logger.info({ id, domain: company.domain, runId }, '[api:companies] Re-scoring queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  app.get('/contacts/for-companies', async (req, reply) => {
    const idsParam = String((req.query as { ids?: string }).ids || '');
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean);
    if (!ids.length) return reply.send({ success: true, data: {} });

    const map = await contactRepository.findByCompanyIds(ids);
    const obj: Record<string, Contact[]> = {};
    for (const [k, v] of map.entries()) obj[k] = v;
    return reply.send({ success: true, data: obj });
  });

  app.get('/companies', async (_req, reply) => reply.redirect('/api/leads'));
}
