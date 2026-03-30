import { FastifyInstance } from 'fastify';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { jobRepository } from '../../storage/repositories/job.repository.js';
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

  // GET /api/companies — same as /leads but grouped — alias for convenience
  app.get('/companies', async (req, reply) => {
    return reply.redirect('/api/leads');
  });
}
