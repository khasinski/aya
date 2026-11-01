export interface TokenUsageRow {
  bucket: string;
  provider: 'codex' | 'claude' | 'grok';
  account: string;
  accountId: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning: number;
}
export interface UsageHistory {
  rows: TokenUsageRow[];
  scannedAt: string;
  files: number;
  partial: boolean;
  warnings: string[];
}
