import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { jobRepository } from '../../storage/repositories/job.repository.js';
import { queueManager } from '../../core/queue.manager.js';
import { generateRunId } from '../../utils/random.js';
import type { Contact } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import {
  objectIdParam,
  domainParamSchema,
  patchCompanyBodySchema,
  patchCompanyStatusBodySchema,
  contactsForCompaniesQuerySchema,
  parseParams,
  parseBody,
  parseQuery,
} from '../schemas.js';

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

  // GET /api/companies/:id — full company profile with contacts + jobs
  app.get('/companies/:id', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const { id } = params;
    logger.info({ id, correlationId: req.correlationId }, '[api:companies] GET /companies/:id');

    const [company, contacts, jobs] = await Promise.all([
      companyRepository.findById(id),
      contactRepository.findByCompanyId(id),
      jobRepository.findByCompanyId(id, false), // include inactive
    ]);

    if (!company) {
      logger.warn({ id }, '[api:companies] Not found');
      return reply.status(404).send({ success: false, error: 'Company not found' });
    }

    const activeJobs   = jobs.filter(j => j.isActive);
    const inactiveJobs = jobs.filter(j => !j.isActive);
    const sortedContacts = sortContactsByRole(contacts);

    logger.info(
      { id, domain: company.domain, contacts: contacts.length, jobs: jobs.length },
      '[api:companies] Company found'
    );

    return reply.send({
      success: true,
      data: {
        company,
        contacts: sortedContacts,
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
  app.get('/companies/domain/:domain', async (req, reply) => {
    const params = parseParams(domainParamSchema, req, reply);
    if (!params) return;
    const { domain } = params;
    logger.info({ domain, correlationId: req.correlationId }, '[api:companies] GET /companies/domain/:domain');

    const company = await companyRepository.findByDomain(domain);
    if (!company) {
      return reply.status(404).send({ success: false, error: `No company found for domain: ${domain}` });
    }

    const contacts = await contactRepository.findByCompanyId(company._id!);
    return reply.send({ success: true, data: { company, contacts } });
  });

  // DELETE /api/companies/:id — remove company + its contacts + jobs
  app.delete('/companies/:id', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const { id } = params;
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

  // PATCH /api/companies/:id — edit lead metadata without touching pipeline status
  app.patch('/companies/:id', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const body = parseBody(patchCompanyBodySchema, req, reply);
    if (!body) return;
    const { id } = params;

    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    const patch: { domain: string; name: string; notes?: string } = {
      domain: company.domain,
      name: body.name ?? company.name,
    };
    if (body.notes !== undefined) patch.notes = body.notes.trim();

    const updated = await companyRepository.upsert(patch);
    logger.info({
      id, domain: company.domain,
      renamed: body.name !== undefined,
      notesUpdated: body.notes !== undefined,
      correlationId: req.correlationId,
    }, '[api:companies] Company updated');
    return reply.send({ success: true, data: updated });
  });

  // PATCH /api/companies/:id/status — manually override lead status
  app.patch('/companies/:id/status', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const body = parseBody(patchCompanyStatusBodySchema, req, reply);
    if (!body) return;
    const { id } = params;
    const { status, reason } = body;

    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });

    await companyRepository.upsert({
      domain: company.domain,
      name: company.name,
      status,
      disqualificationReason: status === 'disqualified' ? (reason ?? 'Manually disqualified') : '',
      manuallyReviewed: true,
    });
    const removedJobs = status === 'disqualified'
      ? await queueManager.removeCompanyPipelineJobs(id)
      : undefined;
    if (status === 'disqualified') {
      await companyRepository.setPipelineStatus(id, 'scored');
    }

    logger.info({ id, domain: company.domain, status, removedJobs, correlationId: req.correlationId }, '[api:companies] Status overridden');
    return reply.send({ success: true, data: { status, removedJobs } });
  });

  // POST /api/companies/:id/enrich — re-queue enrichment for a company
  app.post('/companies/:id/enrich', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const { id } = params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });
    if (company.status === 'disqualified' && company.manuallyReviewed) {
      return reply.status(409).send({ success: false, error: 'Lead is manually disqualified. Change status before re-enrichment.' });
    }

    const runId = generateRunId();
    await queueManager.addEnrichmentJob({ runId, companyId: id, domain: company.domain, sources: ['github', 'hunter', 'clearbit'], force: true, correlationId: req.correlationId });
    logger.info({ id, domain: company.domain, runId, correlationId: req.correlationId }, '[api:companies] Re-enrichment queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  // POST /api/companies/:id/score — re-queue scoring for a company
  app.post('/companies/:id/score', async (req, reply) => {
    const params = parseParams(objectIdParam, req, reply);
    if (!params) return;
    const { id } = params;
    const company = await companyRepository.findById(id);
    if (!company) return reply.status(404).send({ success: false, error: 'Not found' });
    if (company.status === 'disqualified' && company.manuallyReviewed) {
      return reply.status(409).send({ success: false, error: 'Lead is manually disqualified. Change status before re-scoring.' });
    }

    const runId = generateRunId();
    await queueManager.addScoringJob({ runId, companyId: id, correlationId: req.correlationId });
    logger.info({ id, domain: company.domain, runId, correlationId: req.correlationId }, '[api:companies] Re-scoring queued');
    return reply.status(202).send({ success: true, data: { runId } });
  });

  // GET /api/contacts/for-companies?ids=id1,id2,... — batch fetch contacts for multiple companies
  app.get('/contacts/for-companies', async (req, reply) => {
    const q = parseQuery(contactsForCompaniesQuerySchema, req, reply);
    if (!q) return;
    const idsParam = q.ids ?? '';
    const ids = idsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 500);
    if (!ids.length) return reply.send({ success: true, data: {} });

    const map = await contactRepository.findByCompanyIds(ids);
    const obj: Record<string, import('../../types/index.js').Contact[]> = {};
    for (const [k, v] of map.entries()) obj[k] = v;
    return reply.send({ success: true, data: obj });
  });

  // GET /api/companies — same as /leads but grouped — alias for convenience
  app.get('/companies', async (_req, reply) => {
    return reply.redirect('/api/leads');
  });
}
