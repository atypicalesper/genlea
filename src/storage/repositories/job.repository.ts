import { ObjectId } from 'mongodb';
import { Job } from '../../types/index.js';
import { getCollection, COLLECTIONS } from '../mongo.client.js';
import { logger } from '../../utils/logger.js';

type JobRaw = Omit<Job, '_id'> & { _id?: ObjectId };

export const jobRepository = {
  async findByCompanyId(companyId: string, activeOnly = true): Promise<Job[]> {
    const col = getCollection<JobRaw>(COLLECTIONS.JOBS);
    const filter = activeOnly ? { companyId, isActive: true } : { companyId };
    const docs = await col.find(filter as any).sort({ postedAt: -1 }).toArray();
    return docs.map(toJob);
  },

  async upsert(data: Partial<Job> & { companyId: string; title: string }): Promise<Job> {
    const col = getCollection<JobRaw>(COLLECTIONS.JOBS);
    const now = new Date();

    const existing = await col.findOne({
      companyId: data.companyId,
      title: data.title,
      source: data.source,
    } as any);

    if (!existing) {
      const doc: JobRaw = {
        companyId:  data.companyId,
        title:      data.title,
        techTags:   data.techTags ?? [],
        source:     data.source,
        sourceUrl:  data.sourceUrl,
        postedAt:   data.postedAt,
        isActive:   data.isActive ?? true,
        scrapedAt:  now,
      };
      const result = await col.insertOne(doc as any);
      logger.debug({ title: data.title, companyId: data.companyId }, '[job.repository] Job inserted');
      return toJob({ ...doc, _id: result.insertedId });
    }

    await col.updateOne(
      { _id: existing._id } as any,
      {
        $set: {
          scrapedAt: now,
          isActive:  data.isActive ?? existing.isActive,
          ...(data.techTags?.length && { techTags: data.techTags }),
          ...(data.sourceUrl && { sourceUrl: data.sourceUrl }),
          ...(data.postedAt && { postedAt: data.postedAt }),
        },
      }
    );

    const updated = await col.findOne({ _id: existing._id } as any);
    return toJob(updated!);
  },

  async deleteByCompanyId(companyId: string): Promise<void> {
    const col = getCollection<JobRaw>(COLLECTIONS.JOBS);
    await col.deleteMany({ companyId } as any);
  },

  async deactivateAll(companyId: string): Promise<void> {
    const col = getCollection<JobRaw>(COLLECTIONS.JOBS);
    await col.updateMany({ companyId } as any, { $set: { isActive: false } });
  },

  async daysSinceLastPosting(companyId: string): Promise<number | null> {
    const col = getCollection<JobRaw>(COLLECTIONS.JOBS);
    const latest = await col.findOne(
      { companyId, isActive: true } as any,
      { sort: { postedAt: -1 } }
    );
    if (!latest?.postedAt) return null;
    return Math.floor((Date.now() - new Date(latest.postedAt).getTime()) / 86_400_000);
  },
};

function toJob(doc: JobRaw & { _id?: ObjectId }): Job {
  const { _id, ...rest } = doc;
  return { ...rest, _id: _id?.toString() };
}
