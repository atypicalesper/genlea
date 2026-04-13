import { ObjectId, Filter, FindOptions, UpdateFilter } from 'mongodb';
import { Company, LeadStatus, PipelineStatus } from '../../types/index.js';
import { getCollection, COLLECTIONS } from '../mongo.client.js';
import { normalizeDomain } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';

type CompanyDoc = Omit<Company, '_id'> & { _id?: ObjectId };

export const companyRepository = {
  async findById(id: string): Promise<Company | null> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const doc = await col.findOne({ _id: new ObjectId(id) });
    return doc ? toCompany(doc) : null;
  },

  async findByDomain(domain: string): Promise<Company | null> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const doc = await col.findOne({ domain: normalizeDomain(domain) });
    return doc ? toCompany(doc) : null;
  },

  async findMany(
    filter: Filter<CompanyDoc> = {},
    options: FindOptions = {}
  ): Promise<Company[]> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const docs = await col.find(filter, options).toArray();
    return docs.map(toCompany);
  },

  async findHotLeads(
    status: LeadStatus = 'hot',
    limit: number = 100,
    skip: number = 0,
    minScore?: number
  ): Promise<Company[]> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const floor = minScore ?? (status === 'hot_verified' ? 80 : status === 'hot' ? 55 : 38);
    const docs = await col
      .find({ status, score: { $gte: floor } })
      .sort({ score: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    return docs.map(toCompany);
  },

  async upsert(data: Partial<Company> & { domain: string; name: string }): Promise<Company> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const domain = normalizeDomain(data.domain);
    const now = new Date();

    const existing = await col.findOne({ domain });

    if (!existing) {
      const doc: CompanyDoc = {
        name: data.name,
        domain,
        description: data.description,
        linkedinUrl: data.linkedinUrl,
        crunchbaseUrl: data.crunchbaseUrl,
        websiteUrl: data.websiteUrl,
        githubOrg: data.githubOrg,
        hqCountry: data.hqCountry ?? 'US',
        hqState: data.hqState,
        hqCity: data.hqCity,
        employeeCount: data.employeeCount,
        originDevCount: data.originDevCount,
        totalDevCount: data.totalDevCount,
        originRatio: data.originRatio,
        toleranceIncluded: data.toleranceIncluded ?? false,
        fundingStage: data.fundingStage,
        fundingTotalUsd: data.fundingTotalUsd,
        foundedYear: data.foundedYear,
        industry: data.industry ?? [],
        techStack: data.techStack ?? [],
        openRoles: data.openRoles ?? [],
        sources: data.sources ?? [],
        score: data.score ?? 0,
        status: data.status ?? 'pending',
        pipelineStatus: data.pipelineStatus ?? 'discovered',
        manuallyReviewed: false,
        sourcesCount: data.sources?.length ?? 0,
        createdAt: now,
        updatedAt: now,
        lastScrapedAt: now,
        lastEnrichedAt: data.lastEnrichedAt,
      };
      const result = await col.insertOne(doc as CompanyDoc);
      logger.info({ domain, id: result.insertedId.toString() }, '[company.repository] Company inserted');
      return toCompany({ ...doc, _id: result.insertedId });
    }

    const mergedSources = [...new Set([...(existing.sources ?? []), ...(data.sources ?? [])])];

    const update: UpdateFilter<CompanyDoc> = {
      $set: {
        updatedAt: now,
        ...(data.sources?.length && { lastScrapedAt: now, sourcesCount: mergedSources.length }),
        ...(data.name && { name: data.name }),
        ...(data.linkedinUrl && { linkedinUrl: data.linkedinUrl }),
        ...(data.websiteUrl && { websiteUrl: data.websiteUrl }),
        ...(data.crunchbaseUrl && { crunchbaseUrl: data.crunchbaseUrl }),
        ...(data.description && { description: data.description }),
        ...(data.githubOrg && { githubOrg: data.githubOrg }),
        ...(data.hqCountry && { hqCountry: data.hqCountry }),
        ...(data.hqCity && { hqCity: data.hqCity }),
        ...(data.hqState && { hqState: data.hqState }),
        ...(data.fundingStage && { fundingStage: data.fundingStage }),
        ...(data.foundedYear && { foundedYear: data.foundedYear }),
        ...(data.originDevCount !== undefined && { originDevCount: data.originDevCount }),
        ...(data.totalDevCount !== undefined && { totalDevCount: data.totalDevCount }),
        ...(data.originRatio !== undefined && { originRatio: data.originRatio }),
        ...(data.toleranceIncluded !== undefined && { toleranceIncluded: data.toleranceIncluded }),
        ...(data.lastEnrichedAt && { lastEnrichedAt: data.lastEnrichedAt }),
        ...(data.status !== undefined && { status: data.status }),
        ...(data.pipelineStatus !== undefined && { pipelineStatus: data.pipelineStatus }),
        ...(data.manuallyReviewed !== undefined && { manuallyReviewed: data.manuallyReviewed }),
      },
      $max: {
        ...(data.employeeCount !== undefined && { employeeCount: data.employeeCount }),
        ...(data.fundingTotalUsd !== undefined && { fundingTotalUsd: data.fundingTotalUsd }),
        ...(data.score !== undefined && { score: data.score }),
      },
      $addToSet: {
        ...(data.sources?.length   && { sources:   { $each: data.sources } }),
        ...(data.techStack?.length && { techStack: { $each: data.techStack } }),
        ...(data.industry?.length  && { industry:  { $each: data.industry } }),
      },
    };

    const updated = await col.findOneAndUpdate(
      { domain },
      update,
      { returnDocument: 'after' },
    );
    logger.debug({ domain }, '[company.repository] Company upserted');
    return toCompany(updated!);
  },

  async updateScore(
    id: string,
    score: number,
    status: LeadStatus,
    scoreBreakdown: Company['scoreBreakdown'],
    openRoles?: string[],
  ): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.updateOne(
      { _id: new ObjectId(id) },
      [{
        $set: {
          score,
          scoreBreakdown,
          pipelineStatus: 'scored',
          updatedAt: new Date(),
          ...(openRoles !== undefined && { openRoles: [...new Set(openRoles)] }),
          status: {
            $cond: {
              if:   { $eq: ['$manuallyReviewed', true] },
              then: '$status',
              else: status,
            },
          },
        },
      }]
    );
    logger.info({ id, score, status }, '[company.repository] Score updated');
  },

  async disqualify(id: string): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.updateOne(
      { _id: new ObjectId(id), manuallyReviewed: { $ne: true } },
      { $set: { status: 'disqualified', updatedAt: new Date() } }
    );
    logger.info({ id }, '[company.repository] Company disqualified');
  },

  async setPipelineStatus(id: string, pipelineStatus: PipelineStatus, lastEnrichedAt?: Date): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { pipelineStatus, updatedAt: new Date(), ...(lastEnrichedAt && { lastEnrichedAt }) } }
    );
  },

  async setOpenRoles(id: string, roles: string[]): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { openRoles: [...new Set(roles)], updatedAt: new Date() } }
    );
  },

  async count(filter: Filter<CompanyDoc> = {}): Promise<number> {
    return getCollection<CompanyDoc>(COLLECTIONS.COMPANIES).countDocuments(filter);
  },

  async deleteOne(id: string): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.deleteOne({ _id: new ObjectId(id) });
    logger.warn({ id }, '[company.repository] Company deleted');
  },
};

function toCompany(doc: CompanyDoc & { _id?: ObjectId }): Company {
  const { _id, ...rest } = doc;
  return { ...rest, _id: _id?.toString() };
}
