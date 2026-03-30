# Prompt: MongoDB Schema & Repository

You are creating a MongoDB repository for GenLea. Context is in `.claude/CLAUDE.md`.

## Collections & Schemas
All schemas are defined in `ARCHITECTURE.md §6`.

## Task
Create/update a repository in `src/storage/repositories/{noun}.repository.ts`.

## Requirements
1. Use the `MongoClient` singleton from `src/storage/mongo.client.ts`
2. Each repository exposes:
   - `findById(id: string): Promise<T | null>`
   - `findMany(filter: Filter<T>, options?: FindOptions): Promise<T[]>`
   - `upsert(doc: Partial<T>): Promise<T>` — upsert by canonical key (domain for companies, email for contacts)
   - `updateOne(id: string, update: Partial<T>): Promise<void>`
   - `deleteOne(id: string): Promise<void>`
3. Always return plain objects (not Mongoose documents) — use `.lean()` or manual mapping
4. Validate input with Zod schemas before any write operation
5. Include Pino logging for all write operations

## Index Definitions (already created by db:init)
```
companies:  { domain: 1 } unique
contacts:   { email: 1 } unique sparse, { company_id: 1 }
jobs:       { company_id: 1, is_active: 1 }
scrape_logs: { started_at: -1 }
```

## Important
- `domain` is ALWAYS normalized before upsert: lowercase, strip `www.`, strip trailing `/`
- `email` is ALWAYS lowercased before upsert
- On conflict (upsert): merge arrays (union), take MAX of numeric fields, update `updated_at`
