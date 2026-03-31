import { getCollection } from '../mongo.client.js';

export interface AppSettings {
  originRatioThreshold: number;    // min Indian dev ratio to flag — default 0.60
  originRatioMinSample: number;    // min names needed for reliable ratio — default 10
  leadScoreHotThreshold: number;   // score to become hot — default 65
  leadScoreWarmThreshold: number;  // score to become warm — default 50
  updatedAt: Date;
}

type SettingsDoc = AppSettings & { _id: string };

const DEFAULTS: AppSettings = {
  originRatioThreshold: 0.60,
  originRatioMinSample: 10,
  leadScoreHotThreshold: 65,
  leadScoreWarmThreshold: 50,
  updatedAt: new Date(),
};

export const settingsRepository = {
  async get(): Promise<AppSettings> {
    const col = getCollection<SettingsDoc>('settings');
    const doc = await col.findOne({ _id: 'global' } as any);
    if (!doc) return { ...DEFAULTS };
    const { _id: _ignore, ...rest } = doc;
    return rest;
  },

  async patch(updates: Partial<Omit<AppSettings, 'updatedAt'>>): Promise<AppSettings> {
    const col = getCollection<SettingsDoc>('settings');
    await col.updateOne(
      { _id: 'global' } as any,
      { $set: { ...updates, updatedAt: new Date() } },
      { upsert: true }
    );
    return this.get();
  },
};
