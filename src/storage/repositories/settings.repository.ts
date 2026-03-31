import { getCollection } from '../mongo.client.js';

export interface AppSettings {
  originRatioThreshold: number;         // min Indian dev ratio to flag — default 0.60
  originRatioMinSample: number;         // min names needed for reliable ratio — default 5
  leadScoreHotVerifiedThreshold: number; // score to become hot_verified — default 80
  leadScoreHotThreshold: number;        // score to become hot — default 55
  leadScoreWarmThreshold: number;       // score to become warm — default 38
  leadScoreColdThreshold: number;       // score to become cold (below = disqualified) — default 20
  updatedAt: Date;
}

type SettingsDoc = AppSettings & { _id: string };

const DEFAULTS: AppSettings = {
  originRatioThreshold:         0.60,
  originRatioMinSample:         5,
  leadScoreHotVerifiedThreshold: 80,
  leadScoreHotThreshold:        55,
  leadScoreWarmThreshold:       38,
  leadScoreColdThreshold:       20,
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
