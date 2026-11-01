// Read token accounting only. Prompts, tool output and credentials never leave
// the scanner; cached files are rescanned only when size/mtime changes.
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_CLAUDE_CONFIG_DIR, expandUserPath } from './usage';
import { codexUsageSources } from './usage-codex';
import { DEFAULT_GROK_HOME, extractGrokUsageRow } from './usage-grok';
import type { Preset } from './presets';
import type { TokenUsageRow, UsageHistory } from '../shared/usage-history';
type Provider = TokenUsageRow['provider'];
interface Source { provider: Provider; home: string; label: string }
interface Event { id: string; timestamp: number; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; reasoning: number }
const obj = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const num = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const MAX_BYTES = 512 * 1024 * 1024;
const MAX_LINE = 1024 * 1024;
const MAX_FILES = 6000;
const cache = new Map<string, { mtime: number; size: number; partial: boolean; events: Event[] }>();
let inFlight: Promise<UsageHistory> | null = null;
let previous: { key: string; at: number; value: UsageHistory } | null = null;
export class UsageLogParser {
  private model = 'Unknown model';
  private previous: Record<string, unknown> | null = null;
  readonly events = new Map<string, Event>();
  constructor(private provider: Provider) {}
  line(line: string) {
    if (!/token_count|"usage"|turn_context/.test(line)) return;
    let record: Record<string, unknown>; try { record = obj(JSON.parse(line)); } catch { return; }
    const payload = obj(record.payload);
    if (record.type === 'turn_context') { this.model = text(payload.model).slice(0, 200) || this.model; return; }
    if (this.provider === 'grok') {
      const row = extractGrokUsageRow(line); if (!row) return;
      const id = createHash('sha256').update(line).digest('hex');
      this.events.set(id, { id, timestamp: row.tsMs, model: row.models.join(', ') || 'Grok', input: Math.max(0, row.inputTokens - row.cachedReadTokens - (row.totalTokens <= row.inputTokens + row.outputTokens ? row.cacheCreationTokens : 0)), output: row.outputTokens, cacheRead: row.cachedReadTokens, cacheWrite: row.cacheCreationTokens, reasoning: row.reasoningTokens }); return;
    }
    const timestamp = Date.parse(text(record.timestamp)); if (!Number.isFinite(timestamp)) return;
    if (this.provider === 'codex') {
      if (payload.type !== 'token_count') return;
      const info = obj(payload.info), total = obj(info.total_token_usage);
      if (!Object.keys(total).length) return;
      const keys = ['input_tokens', 'output_tokens', 'cached_input_tokens', 'reasoning_output_tokens'];
      const prior = this.previous;
      this.previous = total;
      const reset = prior && (num(total.input_tokens) < num(prior.input_tokens) || num(total.output_tokens) < num(prior.output_tokens));
      const last = obj(info.last_token_usage);
      const delta = Object.fromEntries(keys.map(key => [key, reset ? num((Object.keys(last).length ? last : total)[key]) : Math.max(0, num(total[key]) - num(prior?.[key]))]));
      if (!delta.input_tokens && !delta.output_tokens) return;
      // Forked rollouts may carry the same historical events. A stable event
      // identity prevents counting the copied prefix twice.
      const id = createHash('sha256').update(JSON.stringify([record.timestamp, this.model, total])).digest('hex');
      this.events.set(id, { id, timestamp, model: this.model, input: Math.max(0, delta.input_tokens - delta.cached_input_tokens), output: delta.output_tokens, cacheRead: Math.min(delta.input_tokens, delta.cached_input_tokens), cacheWrite: 0, reasoning: delta.reasoning_output_tokens }); return;
    }
    const message = obj(record.message), usage = obj(message.usage);
    if (record.type !== 'assistant' || !Object.keys(usage).length) return;
    const id = text(message.id) || text(record.uuid); if (!id) return;
    const next: Event = { id, timestamp, model: text(message.model).slice(0, 200) || this.model, input: num(usage.input_tokens), output: num(usage.output_tokens), cacheRead: num(usage.cache_read_input_tokens), cacheWrite: num(usage.cache_creation_input_tokens), reasoning: 0 };
    const prior = this.events.get(id);
    if (prior) for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) next[key] = Math.max(prior[key], next[key]);
    this.events.set(id, next);
  }
}
async function filesUnder(root: string, files: string[], depth = 0): Promise<void> {
  if (depth > 10 || files.length >= MAX_FILES) return;
  let entries; try { entries = await readdir(root, { withFileTypes: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    if (files.length >= MAX_FILES) break;
    if (entry.isDirectory()) await filesUnder(path.join(root, entry.name), files, depth + 1);
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(root, entry.name));
  }
}
export async function scanUsageHistory(sources: Source[], days: number, now = Date.now()): Promise<UsageHistory> {
  const result: UsageHistory = { rows: [], scannedAt: new Date(now).toISOString(), files: 0, partial: false, warnings: [] };
  const since = now - days * 86400000, accounts = new Set<string>(), seen = new Map<string, Event>(), grouped = new Map<string, TokenUsageRow>();
  let bytes = 0, eventCount = 0;
  for (const source of sources) {
    let home: string; try { home = await realpath(source.home); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.partial = true; result.warnings.push(`Could not access ${source.label} history.`); } continue; }
    let historyRoot: string;
    try { historyRoot = await realpath(path.join(home, source.provider === 'claude' ? 'projects' : 'sessions')).catch(async error => { if (source.provider === 'codex' && error.code === 'ENOENT') return realpath(path.join(home, 'archived_sessions')); throw error; }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { result.partial = true; result.warnings.push(`Could not access ${source.label} session logs.`); } continue; }
    const accountId = `${source.provider}:${createHash('sha256').update(historyRoot).digest('hex').slice(0, 16)}`;
    if (accounts.has(accountId)) continue; accounts.add(accountId);
    const files: string[] = [];
    try {
      await filesUnder(historyRoot, files);
      if (source.provider === 'codex') {
        const archived = await realpath(path.join(home, 'archived_sessions')).catch(error => { if (error.code === 'ENOENT') return null; throw error; });
        if (archived && archived !== historyRoot) await filesUnder(archived, files);
      }
    } catch { result.partial = true; result.warnings.push(`Some ${source.label} history could not be listed.`); }
    if (files.length >= MAX_FILES) result.partial = true;
    const candidates = (await Promise.all(files.map(async file => { try { return { file, info: await stat(file) }; } catch { return null; } }))).filter((value): value is NonNullable<typeof value> => !!value && value.info.mtimeMs >= since).sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    seen.clear();
    for (const { file, info } of candidates) {
      if (result.files >= MAX_FILES || bytes >= MAX_BYTES || eventCount >= 200000) { result.partial = true; break; }
      result.files++;
      let events = cache.get(file);
      if (!events || events.mtime !== info.mtimeMs || events.size !== info.size) {
        const parser = new UsageLogParser(source.provider);
        const stream = createReadStream(file, { highWaterMark: 65536 }); stream.setEncoding('utf8');
        let buffer = '', dropping = false, complete = true, partial = false;
        try {
          for await (const chunk of stream) {
            const data = String(chunk); bytes += Buffer.byteLength(data);
            if (bytes > MAX_BYTES) { complete = false; result.partial = true; break; }
            const lines = data.split('\n');
            for (let index = 0; index < lines.length; index++) {
              const part = lines[index], ended = index < lines.length - 1;
              if (!dropping) buffer += part;
              if (buffer.length > MAX_LINE) {
                const types = [...buffer.slice(0, 4096).matchAll(/"type"\s*:\s*"([^"]+)"/g)].map(match => match[1]);
                const knownNonAccounting = source.provider === 'codex' ? types[0] === 'response_item' || types[0] === 'session_meta' || (types[0] === 'event_msg' && ['user_message', 'agent_message', 'agent_reasoning'].includes(types[1])) : source.provider === 'claude' && ['user', 'progress', 'system'].includes(types[0]);
                if (!knownNonAccounting) partial = true;
                buffer = ''; dropping = true;
              }
              if (ended) { if (!dropping) parser.line(buffer); buffer = ''; dropping = false; }
            }
          }
          if (buffer && !dropping && complete) parser.line(buffer);
        } catch { result.partial = true; complete = false; } finally { stream.destroy(); }
        events = { mtime: info.mtimeMs, size: info.size, partial, events: [...parser.events.values()] };
        if (complete) { cache.set(file, events); if (cache.size > 2000) cache.delete(cache.keys().next().value!); }
      }
      result.partial ||= events.partial;
      eventCount += events.events.length;
      for (const event of events.events) {
        if (event.timestamp < since || event.timestamp > now) continue;
        const old = seen.get(event.id);
        if (!old || event.input + event.output + event.cacheRead + event.cacheWrite > old.input + old.output + old.cacheRead + old.cacheWrite) seen.set(event.id, event);
      }
    }
    for (const event of seen.values()) {
      const date = new Date(event.timestamp);
      if (days === 1) date.setMinutes(0, 0, 0); else date.setHours(0, 0, 0, 0);
      const bucket = date.toISOString(), key = `${accountId}|${event.model}|${bucket}`;
      let row = grouped.get(key);
      if (!row) { row = { bucket, provider: source.provider, accountId, account: source.label, model: event.model, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }; grouped.set(key, row); }
      for (const token of ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'] as const) row[token] += event[token];
    }
  }
  result.rows = [...grouped.values()].sort((a, b) => a.bucket.localeCompare(b.bucket));
  return result;
}
export async function readUsageHistory(presets: Preset[], requestedDays: unknown, refresh = false): Promise<UsageHistory> {
  const days = [1, 7, 30, 90].includes(Number(requestedDays)) ? Number(requestedDays) : 7;
  const sources: Source[] = codexUsageSources(presets).map(s => ({ provider: 'codex', home: s.home, label: s.label }));
  const claude = presets.filter(p => p.agent === 'claude');
  sources.push(...(claude.length ? claude.map(p => ({ provider: 'claude' as const, home: expandUserPath(p.configDir || DEFAULT_CLAUDE_CONFIG_DIR), label: p.name })) : [{ provider: 'claude' as const, home: expandUserPath(process.env.CLAUDE_CONFIG_DIR || DEFAULT_CLAUDE_CONFIG_DIR), label: 'Claude Code' }]));
  const grok = presets.filter(p => p.agent === 'grok');
  sources.push(...(grok.length ? grok.map(p => ({ provider: 'grok' as const, home: expandUserPath(p.configDir || DEFAULT_GROK_HOME), label: p.name })) : [{ provider: 'grok' as const, home: DEFAULT_GROK_HOME, label: 'Grok' }]));
  const key = JSON.stringify([sources, days]);
  if (!refresh && previous?.key === key && Date.now() - previous.at < 15000) return previous.value;
  if (inFlight) await inFlight;
  inFlight = scanUsageHistory(sources, days);
  try { const value = await inFlight; previous = { key, value, at: Date.now() }; return value; } finally { inFlight = null; }
}
