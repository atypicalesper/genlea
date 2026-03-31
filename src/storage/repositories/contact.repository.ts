import { ObjectId, Filter } from 'mongodb';
import { Contact, ContactRole } from '../../types/index.js';
import { getCollection, COLLECTIONS } from '../mongo.client.js';
import { normalizeEmail } from '../../utils/random.js';
import { logger } from '../../utils/logger.js';

// MongoDB document shape — _id is always ObjectId internally
type ContactRaw = Omit<Contact, '_id'> & { _id?: ObjectId };

export const contactRepository = {
  async findById(id: string): Promise<Contact | null> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const doc = await col.findOne({ _id: new ObjectId(id) } as any);
    return doc ? toContact(doc) : null;
  },

  async findByCompanyId(companyId: string): Promise<Contact[]> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const docs = await col.find({ companyId } as any).toArray();
    return docs.map(toContact);
  },

  /** Batch fetch contacts for many companies in a single query — avoids N+1 on export */
  async findByCompanyIds(ids: string[]): Promise<Map<string, Contact[]>> {
    if (ids.length === 0) return new Map();
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const docs = await col.find({ companyId: { $in: ids } } as any).toArray();
    const map = new Map<string, Contact[]>();
    for (const doc of docs) {
      const id = doc.companyId;
      if (!map.has(id)) map.set(id, []);
      map.get(id)!.push(toContact(doc));
    }
    return map;
  },

  async findByEmail(email: string): Promise<Contact | null> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const doc = await col.findOne({ email: normalizeEmail(email) } as any);
    return doc ? toContact(doc) : null;
  },

  async findByCompanyAndRole(companyId: string, role: ContactRole): Promise<Contact[]> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const docs = await col.find({ companyId, role } as any).toArray();
    return docs.map(toContact);
  },

  async upsert(
    data: Partial<Contact> & { companyId: string; fullName: string; role: ContactRole }
  ): Promise<Contact> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    const now = new Date();
    const email = data.email ? normalizeEmail(data.email) : undefined;

    // Dedup by email+companyId so the same email can exist under different companies
    const existing = email
      ? await col.findOne({ email, companyId: data.companyId } as any)
      : await col.findOne({ companyId: data.companyId, fullName: data.fullName } as any);

    if (!existing) {
      const doc: ContactRaw = {
        fullName:      data.fullName,
        companyId:     data.companyId,
        role:          data.role,
        firstName:     data.firstName,
        lastName:      data.lastName,
        email,
        emailVerified:  data.emailVerified ?? false,
        emailConfidence: data.emailConfidence ?? 0,
        phone:         data.phone,
        linkedinUrl:   data.linkedinUrl,
        twitterUrl:    data.twitterUrl,
        location:      data.location,
        isIndianOrigin: data.isIndianOrigin,
        sources:       data.sources ?? [],
        createdAt:     now,
        updatedAt:     now,
      };
      const result = await col.insertOne(doc as any);
      logger.debug({ email, role: data.role }, '[contact.repository] Contact inserted');
      return toContact({ ...doc, _id: result.insertedId });
    }

    await col.updateOne(
      { _id: existing._id } as any,
      {
        $set: {
          updatedAt: now,
          // Upgrade email if we now have one (e.g. Hunter found it after GitHub inserted name-only)
          ...(email && !existing.email && { email }),
          // Upgrade role if it improves from Unknown → a real role
          ...(data.role && data.role !== 'Unknown' && existing.role === 'Unknown' && { role: data.role }),
          ...(data.phone && { phone: data.phone }),
          ...(data.linkedinUrl && { linkedinUrl: data.linkedinUrl }),
          ...(data.emailVerified !== undefined && { emailVerified: data.emailVerified }),
          ...(data.isIndianOrigin !== undefined && { isIndianOrigin: data.isIndianOrigin }),
        },
        $max: {
          ...(data.emailConfidence !== undefined && { emailConfidence: data.emailConfidence }),
        },
        $addToSet: {
          ...(data.sources?.length && { sources: { $each: data.sources } }),
        },
      }
    );

    const updated = await col.findOne({ _id: existing._id } as any);
    return toContact(updated!);
  },

  async markEmailVerified(id: string, confidence: number): Promise<void> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    await col.updateOne(
      { _id: new ObjectId(id) } as any,
      { $set: { emailVerified: true, emailConfidence: confidence, updatedAt: new Date() } }
    );
  },

  async deleteByCompanyId(companyId: string): Promise<void> {
    const col = getCollection<ContactRaw>(COLLECTIONS.CONTACTS);
    await col.deleteMany({ companyId } as any);
  },

  async count(filter: Filter<ContactRaw> = {}): Promise<number> {
    return getCollection<ContactRaw>(COLLECTIONS.CONTACTS).countDocuments(filter as any);
  },
};

function toContact(doc: ContactRaw & { _id?: ObjectId }): Contact {
  const { _id, ...rest } = doc;
  return { ...rest, _id: _id?.toString() };
}
