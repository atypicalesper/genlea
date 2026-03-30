import { ObjectId } from 'mongodb';
import { ScrapeLog, ScrapeJobStatus, ScraperSource } from '../../types/index.js';
import { getCollection, COLLECTIONS } from '../mongo.client.js';

type ScrapeLogDoc = Omit<ScrapeLog, '_id'> & { _id?: ObjectId };

export const scrapeLogRepository = {
  async create(data: Omit<ScrapeLog, '_id'>): Promise<ScrapeLog> {
    const col = getCollection<ScrapeLogDoc>(COLLECTIONS.SCRAPE_LOGS);
    const result = await col.insertOne(data as ScrapeLogDoc);
    return { ...data, _id: result.insertedId.toString() };
  },

  async complete(
    id: string,
    updates: {
      status: ScrapeJobStatus;
      companiesFound: number;
      contactsFound: number;
      jobsFound: number;
      errors: string[];
      durationMs: number;
    }
  ): Promise<void> {
    const col = getCollection<ScrapeLogDoc>(COLLECTIONS.SCRAPE_LOGS);
    await col.updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, completedAt: new Date() } }
    );
  },

  async findRecent(scraper?: ScraperSource, limit = 50): Promise<ScrapeLog[]> {
    const col = getCollection<ScrapeLogDoc>(COLLECTIONS.SCRAPE_LOGS);
    const filter = scraper ? { scraper } : {};
    const docs = await col
      .find(filter)
      .sort({ startedAt: -1 })
      .limit(limit)
      .toArray();
    return docs.map(d => {
      const { _id, ...rest } = d;
      return { ...rest, _id: _id?.toString() };
    });
  },

  async getStats(): Promise<{ total: number; success: number; failed: number; partial: number }> {
    const col = getCollection<ScrapeLogDoc>(COLLECTIONS.SCRAPE_LOGS);
    const [total, success, failed, partial] = await Promise.all([
      col.countDocuments(),
      col.countDocuments({ status: 'success' }),
      col.countDocuments({ status: 'failed' }),
      col.countDocuments({ status: 'partial' }),
    ]);
    return { total, success, failed, partial };
  },
};
