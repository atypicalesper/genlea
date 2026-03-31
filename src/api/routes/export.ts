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

      const EXPORT_LIMIT = 5000;
      const [companies, total] = await Promise.all([
        companyRepository.findMany(filter, { sort: { score: -1 }, limit: EXPORT_LIMIT }),
        companyRepository.count(filter),
      ]);
      if (total > EXPORT_LIMIT) {
        logger.warn({ total, limit: EXPORT_LIMIT }, '[api:export] Result set truncated — increase EXPORT_LIMIT or add filters');
      }

      // Fetch all contacts in one query (avoids N+1 for large exports)
      const companyIds = companies.map(c => c._id).filter(Boolean) as string[];
      const contactMap = await contactRepository.findByCompanyIds(companyIds);

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
        .header('X-Total-Count', String(total))
        .header('X-Truncated',   String(total > EXPORT_LIMIT))
        .send(csv);
    }
  );
}
