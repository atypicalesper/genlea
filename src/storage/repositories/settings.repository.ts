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
  originRatioThreshold:  0.60,
  originRatioMinSample:  5,   // was 10 — most startups have <10 public contributors
  leadScoreHotThreshold:  55,  // was 65 — unknown ratio now gives 10pts, lower bar
  leadScoreWarmThreshold: 38,  // was 50
  updatedAt: new Date(),
};

let _settingsCache: AppSettings | null = null;
let _settingsCacheAt = 0;
const CACHE_TTL_MS = 60_000;

export const settingsRepository = {
  async get(): Promise<AppSettings> {
    if (_settingsCache && Date.now() - _settingsCacheAt < CACHE_TTL_MS) {
      return _settingsCache;
    }
    const col = getCollection<SettingsDoc>('settings');
    const doc = await col.findOne({ _id: 'global' } as any);
    const result: AppSettings = doc ? (() => { const { _id: _ignore, ...rest } = doc; return rest; })() : { ...DEFAULTS };
    _settingsCache = result;
    _settingsCacheAt = Date.now();
    return result;
  },

  async patch(updates: Partial<Omit<AppSettings, 'updatedAt'>>): Promise<AppSettings> {
    const col = getCollection<SettingsDoc>('settings');
    await col.updateOne(
      { _id: 'global' } as any,
      { $set: { ...updates, updatedAt: new Date() } },
      { upsert: true }
    );
    _settingsCache = null;
    return this.get();
  },
};
