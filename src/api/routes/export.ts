import { FastifyInstance } from 'fastify';
import { stringify } from 'csv-stringify/sync';
import { companyRepository } from '../../storage/repositories/company.repository.js';
import { contactRepository } from '../../storage/repositories/contact.repository.js';
import { LeadStatus } from '../../types/index.js';
import { logger } from '../../utils/logger.js';
import { mkdir, writeFile } from 'fs/promises';
import { join } from 'path';

export async function exportRoutes(app: FastifyInstance) {

  // GET /api/export/csv?status=hot&minScore=65  (both optional — omit for all)
  app.get<{ Querystring: { status?: LeadStatus; minScore?: string } }>(
    '/export/csv',
    async (req, reply) => {
      const { status, minScore: minScoreStr } = req.query;
      const minScore = minScoreStr ? parseInt(minScoreStr) : 0;

      logger.info({ status, minScore }, '[api:export] CSV export requested');

      const filter: Record<string, unknown> = {};
      if (status)   filter['status'] = status;
      if (minScore) filter['score']  = { $gte: minScore };

      const companies = await companyRepository.findMany(
        filter,
        { sort: { score: -1 }, limit: 5000 }
      );

      // Fetch contacts for all companies in one pass
      const contactMap = new Map<string, Awaited<ReturnType<typeof contactRepository.findByCompanyId>>>();
      await Promise.all(
        companies.map(async c => {
          if (c._id) contactMap.set(c._id, await contactRepository.findByCompanyId(c._id));
        })
      );

      const rows = companies.flatMap(c => {
        const contacts = contactMap.get(c._id ?? '') ?? [];
        const ceo = contacts.find(x => ['CEO', 'Founder'].includes(x.role));
        const hr  = contacts.find(x => ['HR', 'Recruiter', 'Head of Talent'].includes(x.role));

        return [{
          Company:         c.name,
          Domain:          c.domain,
          Score:           c.score,
          Status:          c.status,
          'Origin Ratio':  c.originRatio?.toFixed(2) ?? '',
          'Employee Count': c.employeeCount ?? '',
          'Tech Stack':    c.techStack.join(', '),
          'Funding Stage': c.fundingStage ?? '',
          'HQ State':      c.hqState ?? '',
          'HQ City':       c.hqCity ?? '',
          LinkedIn:        c.linkedinUrl ?? '',
          'CEO Name':      ceo?.fullName ?? '',
          'CEO Email':     ceo?.email ?? '',
          'CEO LinkedIn':  ceo?.linkedinUrl ?? '',
          'HR Name':       hr?.fullName ?? '',
          'HR Email':      hr?.email ?? '',
          'HR LinkedIn':   hr?.linkedinUrl ?? '',
          'HR Phone':      hr?.phone ?? '',
          'Open Roles':    c.openRoles.join('; '),
        }];
      });

      const csv = stringify(rows, { header: true });

      // Also save to disk
      try {
        await mkdir(join(process.cwd(), 'exports'), { recursive: true });
        const filename = `leads-${status ?? 'all'}-${Date.now()}.csv`;
        await writeFile(join(process.cwd(), 'exports', filename), csv);
        logger.info({ filename, rows: rows.length }, '[api:export] CSV saved to disk');
      } catch (err) {
        logger.warn({ err }, '[api:export] Could not write CSV to disk');
      }

      logger.info({ rows: rows.length, status }, '[api:export] CSV export complete');

      return reply
        .header('Content-Type', 'text/csv')
        .header('Content-Disposition', `attachment; filename="genlea-${status ?? 'all'}-leads.csv"`)
        .send(csv);
    }
  );
}
