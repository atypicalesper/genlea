export type NameInput = { firstName?: string; lastName?: string; fullName?: string };

export interface RatioResult {
  indianCount: number;
  totalCount: number;
  ratio: number;
  reliable: boolean;
}

export interface NameClassifier {
  name: string;
  isAvailable: () => boolean;
  classify: (names: NameInput[]) => Promise<RatioResult>;
}

export const MIN_SAMPLE    = parseInt(process.env['INDIAN_RATIO_MIN_SAMPLE'] ?? '10');
export const MIN_CONFIDENCE = 0.65;
export const ETHNICOLR_URL  = process.env['ETHNICOLR_URL'] ?? 'http://localhost:5050';
