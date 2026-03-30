import { ObjectId, Filter, FindOptions, UpdateFilter } from 'mongodb';
import { Company, LeadStatus } from '../../types/index.js';
import { getCollection, COLLECTIONS } from '../mongo.client.js';
import { normalizeDomain } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';

type CompanyDoc = Omit<Company, '_id'> & { _id?: ObjectId };

export const companyRepository = {
  /** Find a company by MongoDB _id */
  async findById(id: string): Promise<Company | null> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const doc = await col.findOne({ _id: new ObjectId(id) });
    return doc ? toCompany(doc) : null;
  },

  /** Find a company by domain (canonical key) */
  async findByDomain(domain: string): Promise<Company | null> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const doc = await col.findOne({ domain: normalizeDomain(domain) });
    return doc ? toCompany(doc) : null;
  },

  /** Find many companies with optional filters */
  async findMany(
    filter: Filter<CompanyDoc> = {},
    options: FindOptions = {}
  ): Promise<Company[]> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const docs = await col.find(filter, options).toArray();
    return docs.map(toCompany);
  },

  /** Find hot/warm leads sorted by score descending */
  async findHotLeads(
    status: LeadStatus = 'hot',
    limit: number = 100,
    skip: number = 0
  ): Promise<Company[]> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    const minScore = status === 'hot_verified' ? 80 : status === 'hot' ? 65 : 50;
    const docs = await col
      .find({ status, score: { $gte: minScore } })
      .sort({ score: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    return docs.map(toCompany);
  },

  /**
   * Upsert a company by domain (canonical key).
   * On conflict: union arrays, take max of numeric fields, update timestamps.
   */
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
        manuallyReviewed: false,
        sourcesCount: data.sources?.length ?? 0,
        createdAt: now,
        updatedAt: now,
        lastScrapedAt: now,
      };
      const result = await col.insertOne(doc as CompanyDoc);
      logger.info({ domain, id: result.insertedId.toString() }, '[company.repository] Company inserted');
      return toCompany({ ...doc, _id: result.insertedId });
    }

    // Merge: union arrays, keep max of numeric fields
    const update: UpdateFilter<CompanyDoc> = {
      $set: {
        updatedAt: now,
        lastScrapedAt: now,
        ...(data.name && { name: data.name }),
        ...(data.linkedinUrl && { linkedinUrl: data.linkedinUrl }),
        ...(data.description && { description: data.description }),
        ...(data.githubOrg && { githubOrg: data.githubOrg }),
        ...(data.hqCity && { hqCity: data.hqCity }),
        ...(data.hqState && { hqState: data.hqState }),
        ...(data.fundingStage && { fundingStage: data.fundingStage }),
      },
      $max: {
        ...(data.employeeCount !== undefined && { employeeCount: data.employeeCount }),
        ...(data.fundingTotalUsd !== undefined && { fundingTotalUsd: data.fundingTotalUsd }),
        ...(data.originDevCount !== undefined && { originDevCount: data.originDevCount }),
        ...(data.totalDevCount !== undefined && { totalDevCount: data.totalDevCount }),
        ...(data.originRatio !== undefined && { originRatio: data.originRatio }),
        ...(data.score !== undefined && { score: data.score }),
      },
      $addToSet: {
        ...(data.sources?.length && { sources: { $each: data.sources } }),
        ...(data.techStack?.length && { techStack: { $each: data.techStack } }),
        ...(data.industry?.length && { industry: { $each: data.industry } }),
        ...(data.openRoles?.length && { openRoles: { $each: data.openRoles } }),
      },
    };

    await col.updateOne({ domain }, update);
    logger.debug({ domain }, '[company.repository] Company upserted');

    const updated = await col.findOne({ domain });
    return toCompany(updated!);
  },

  /** Update company score + status after scoring phase */
  async updateScore(
    id: string,
    score: number,
    status: LeadStatus,
    scoreBreakdown: Company['scoreBreakdown']
  ): Promise<void> {
    const col = getCollection<CompanyDoc>(COLLECTIONS.COMPANIES);
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { score, status, scoreBreakdown, updatedAt: new Date() } }
    );
    logger.info({ id, score, status }, '[company.repository] Score updated');
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
