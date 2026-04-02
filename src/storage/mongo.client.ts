import { MongoClient, Db, Collection, ServerApiVersion } from 'mongodb';
import { logger } from '../utils/logger.js';

let client: MongoClient | null = null;
let db: Db | null = null;
// Prevents duplicate connections when multiple callers await connectMongo() concurrently
let connectPromise: Promise<Db> | null = null;

export async function connectMongo(): Promise<Db> {
  if (db) return db;
  if (connectPromise) return connectPromise;

  connectPromise = (async () => {
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
      serverSelectionTimeoutMS: 10_000,
      connectTimeoutMS: 15_000,
      socketTimeoutMS: 30_000,
    });

    await client.connect();
    await client.db('admin').command({ ping: 1 });

    db = client.db(dbName);
    logger.info({ dbName }, 'MongoDB connected');
    return db;
  })().catch(err => {
    // Reset so a retry call can attempt again
    connectPromise = null;
    client = null;
    db = null;
    throw err;
  });

  return connectPromise;
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
    connectPromise = null;
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
