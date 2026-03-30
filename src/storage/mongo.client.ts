import { MongoClient, Db, Collection, ServerApiVersion } from 'mongodb';
import { logger } from '../utils/logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;

  const uri = process.env['MONGO_URI'];
  if (!uri) throw new Error('MONGO_URI env var is required');

  const dbName = process.env['MONGO_DB_NAME'] ?? 'genlea';

  const isAtlas = uri.startsWith('mongodb+srv://');

  client = new MongoClient(uri, {
    ...(isAtlas && {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
      },
    }),
    maxPoolSize: 10,
    minPoolSize: 2,
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 15000,
  });

  await client.connect();

  // Verify connection with a ping (same as Atlas quickstart recommends)
  await client.db('admin').command({ ping: 1 });

  db = client.db(dbName);
  logger.info({ dbName }, 'MongoDB connected');
  return db;
}

export function getDb(): Db {
  if (!db) throw new Error('MongoDB not connected — call connectMongo() first');
  return db;
}

export function getCollection<T extends object>(name: string): Collection<T> {
  return getDb().collection<T>(name);
}

export async function closeMongo(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logger.info('MongoDB disconnected');
  }
}

// Collection name constants
export const COLLECTIONS = {
  COMPANIES:   'companies',
  CONTACTS:    'contacts',
  JOBS:        'jobs',
  SCRAPE_LOGS: 'scrape_logs',
} as const;
