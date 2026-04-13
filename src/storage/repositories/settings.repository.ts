import { getCollection } from '../mongo.client.js';

export interface AppSettings {
  originRatioThreshold: number;         // min Indian dev ratio to flag — default 0.10
  originRatioMinSample: number;         // min names needed for reliable ratio — default 5
  targetTechTags: string[];             // tech tags that score positively — default nodejs,typescript,…
  highValueIndustries: string[];        // industry keywords that grant bonus points — default ai,saas,…
  leadScoreHotVerifiedThreshold: number; // score to become hot_verified — default 80
  leadScoreHotThreshold: number;        // score to become hot — default 55
  leadScoreWarmThreshold: number;       // score to become warm — default 38
  leadScoreColdThreshold: number;       // score to become cold (below = disqualified) — default 20
  workerConcurrencyDiscovery: number;   // concurrent discovery jobs — default 10
  workerConcurrencyEnrichment: number;  // concurrent enrichment jobs — default 15
  workerConcurrencyScoring: number;     // concurrent scoring jobs — default 30
  updatedAt: Date;
}

type SettingsDoc = AppSettings & { _id: string };

const DEFAULTS: AppSettings = {
  originRatioThreshold:         0.10,
  originRatioMinSample:         5,
  targetTechTags:               ['nodejs', 'typescript', 'python', 'react', 'nextjs', 'nestjs', 'frontend', 'backend', 'fullstack', 'ai', 'ml', 'generative-ai', 'fastapi'],
  highValueIndustries:          ['ai', 'saas', 'fintech', 'healthtech', 'edtech'],
  leadScoreHotVerifiedThreshold: 80,
  leadScoreHotThreshold:        55,
  leadScoreWarmThreshold:       38,
  leadScoreColdThreshold:       20,
  workerConcurrencyDiscovery:   10,
  workerConcurrencyEnrichment:  15,
  workerConcurrencyScoring:     30,
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
