import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UsageHistory, TokenUsageRow } from '../../shared/usage-history';
import type { GrokUsage, UsageAccount } from '../types';
import './usage-dashboard.css';
import { USAGE_STALE_AFTER_MS } from '../ui-timing';
const total = (r: TokenUsageRow) => r.input + r.output + r.cacheRead + r.cacheWrite;
const number = (value: number) => Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const exact = (value: number) => value.toLocaleString();
const names = { codex: 'Codex', claude: 'Claude Code', grok: 'Grok' };
function Icon({ name }: { name: string }) { return <span className="aya-usage-icon" aria-hidden="true">{name}</span>; }
export function UsageDashboard({ onClose, accounts, codex, antigravity, grok }: { onClose: () => void; accounts: UsageAccount[]; codex: UsageAccount[]; antigravity: UsageAccount[]; grok: GrokUsage | null }) {
  const [tab, setTab] = useState<'tokens' | 'limits'>('tokens');
  const [days, setDays] = useState(7);
  const [provider, setProvider] = useState('all');
  const [account, setAccount] = useState('all');
  const [model, setModel] = useState('all');
  const [history, setHistory] = useState<UsageHistory | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [limitData, setLimitData] = useState({ accounts, codex, antigravity, grok });
  const [limitsLoading, setLimitsLoading] = useState(false);
  const [limitsError, setLimitsError] = useState('');
  useEffect(() => setLimitData({ accounts, codex, antigravity, grok }), [accounts, codex, antigravity, grok]);
  const refreshLimits = async () => {
    if (limitsLoading) return;
    setLimitsLoading(true); setLimitsError('');
    const results = await Promise.allSettled([window.aya.getUsage(), window.aya.getCodexUsage(), window.aya.getAntigravityUsage(), window.aya.getGrokUsage()]);
    setLimitData(old => ({ accounts: results[0].status === 'fulfilled' ? results[0].value as UsageAccount[] : old.accounts, codex: results[1].status === 'fulfilled' ? results[1].value as UsageAccount[] : old.codex, antigravity: results[2].status === 'fulfilled' ? results[2].value as UsageAccount[] : old.antigravity, grok: results[3].status === 'fulfilled' ? results[3].value as GrokUsage | null : old.grok }));
    if (results.some(result => result.status === 'rejected')) setLimitsError('Some limit snapshots could not be refreshed. Previous readings remain visible.');
    setLimitsLoading(false);
  };
  const root = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; close.current?.focus(); return () => previous?.focus(); }, []);
  useEffect(() => {
    let active = true;
    if (!window.aya.getUsageHistory) { setError('Token history is available in the updated Aya desktop app.'); setLoading(false); return; }
    setLoading(true); setError('');
    void window.aya.getUsageHistory(days, revision > 0).then(result => { if (active) setHistory(result); }, e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [days, revision]);
  const rows = useMemo(() => (history?.rows || []).filter(r => (provider === 'all' || r.provider === provider) && (account === 'all' || r.accountId === account) && (model === 'all' || r.model === model)), [history, provider, account, model]);
  const sums = rows.reduce((sum, r) => ({ input: sum.input + r.input, output: sum.output + r.output, cacheRead: sum.cacheRead + r.cacheRead, cacheWrite: sum.cacheWrite + r.cacheWrite }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  const sum = sums.input + sums.output + sums.cacheRead + sums.cacheWrite;
  const modelRows = [...rows.reduce((map, row) => { const key = row.provider + ':' + row.model; const item = map.get(key) || { provider: row.provider, model: row.model, tokens: 0, input: 0, output: 0, cache: 0 }; item.tokens += total(row); item.input += row.input; item.output += row.output; item.cache += row.cacheRead + row.cacheWrite; map.set(key, item); return map; }, new Map<string, { provider: TokenUsageRow['provider']; model: string; tokens: number; input: number; output: number; cache: number }>()).values()].sort((a, b) => b.tokens - a.tokens);
  const accountOptions = [...new Map((history?.rows || []).filter(r => provider === 'all' || r.provider === provider).map(r => [r.accountId, { id: r.accountId, name: `${names[r.provider]} · ${r.account}` }])).values()];
  const modelOptions = [...new Set((history?.rows || []).filter(r => (provider === 'all' || r.provider === provider) && (account === 'all' || r.accountId === account)).map(r => r.model))].sort();
  const keyDown = useCallback((event: React.KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
    if (event.key === 'Tab') {
      const nodes = root.current?.querySelectorAll<HTMLElement>('button:not(:disabled),select,input,a[href],[tabindex="0"]');
      if (!nodes?.length) return;
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    }
  }, [onClose]);
  const limitGroups = [{ name: 'Codex', accounts: limitData.codex }, { name: 'Claude Code', accounts: limitData.accounts }, { name: 'Antigravity', accounts: limitData.antigravity }];
  return <div className="aya-usage-screen" ref={root} role="dialog" aria-modal="true" aria-label="Usage" onKeyDown={keyDown}>
    <header className="aya-usage-heading"><div><span className="aya-usage-eyebrow">YOUR AGENTS, AT A GLANCE</span><h1>Usage</h1><p>Token activity and account limits, in one place.</p></div><button ref={close} onClick={onClose} aria-label="Close usage" title="Close · Esc"><Icon name="close" /></button></header>
    <div className="aya-usage-controls"><div className="aya-usage-tabs" role="tablist" aria-label="Usage view">{(['tokens', 'limits'] as const).map(value => <button role="tab" aria-selected={tab === value} key={value} onClick={() => { setTab(value); if (value === 'limits') void refreshLimits(); }}>{value === 'tokens' ? 'Tokens' : 'Limits'}</button>)}</div>
      {tab === 'tokens' && <div className="aya-usage-periods" aria-label="Time range">{[1, 7, 30, 90].map(value => <button key={value} aria-pressed={days === value} onClick={() => { if (days !== value) { setHistory(null); setLoading(true); setDays(value); } }}>{value === 1 ? '24 hours' : `${value} days`}</button>)}</div>}
      <span className="aya-usage-spacer" /><button className="aya-usage-refresh" disabled={tab === 'tokens' ? loading : limitsLoading} onClick={() => tab === 'tokens' ? setRevision(n => n + 1) : void refreshLimits()} aria-label="Refresh usage" title={tab === 'tokens' ? "Rescan local token history" : "Refresh provider snapshots"}><Icon name="refresh" /><span>{(tab === 'tokens' ? loading : limitsLoading) ? tab === 'tokens' ? 'Scanning…' : 'Refreshing…' : 'Refresh'}</span></button>
    </div>
    <div className="aya-usage-scroll">
    {tab === 'tokens' ? <>
      <div className="aya-usage-filters"><label><span>Provider</span><select aria-label="Usage provider" value={provider} onChange={e => { setProvider(e.target.value); setAccount('all'); setModel('all'); }}><option value="all">All providers</option>{Object.entries(names).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label><label><span>Account</span><select aria-label="Usage account" value={account} onChange={e => { setAccount(e.target.value); setModel('all'); }}><option value="all">All accounts</option>{accountOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label><span>Model</span><select aria-label="Usage model" value={model} onChange={e => setModel(e.target.value)}><option value="all">All models</option>{modelOptions.map(m => <option key={m}>{m}</option>)}</select></label>{(provider !== 'all' || account !== 'all' || model !== 'all') && <button className="aya-usage-reset" onClick={() => { setProvider('all'); setAccount('all'); setModel('all'); }}>Reset filters</button>}</div>
      {error && <div className="aya-usage-notice" role="alert">{error}<button onClick={() => setRevision(n => n + 1)}>Try again</button></div>}
      {history?.partial && <div className="aya-usage-notice" role="status">Partial history · Some logs were unreadable or the scan reached its limit. Totals reflect the available records.{history.warnings.map(w => <span key={w}>{w}</span>)}</div>}
      <div className="aya-usage-metrics" aria-busy={loading}>{[{ title: 'Total tokens', value: sum, hint: 'Input, output and cache' }, { title: 'Input', value: sums.input, hint: 'Uncached input tokens' }, { title: 'Output', value: sums.output, hint: 'Includes reported reasoning' }, { title: 'Cache reuse', value: sums.cacheRead, hint: `${sums.input + sums.cacheRead + sums.cacheWrite > 0 ? Math.round(sums.cacheRead / (sums.input + sums.cacheRead + sums.cacheWrite) * 100) + '% of input read from cache' : 'Cached input tokens'}` }].map(metric => <article key={metric.title}><span>{metric.title}</span><strong title={exact(metric.value)}>{loading && !history ? '—' : !rows.length ? '—' : number(metric.value)}</strong><small>{metric.hint}</small></article>)}</div>
      {loading && !history ? <div className="aya-usage-empty" role="status"><Icon name="data_usage" /><h2>Reading local usage history</h2><p>Your agents keep their own logs. Aya is collecting their token counts.</p></div> : !rows.length ? <div className="aya-usage-empty"><Icon name="bar_chart" /><h2>No token history in this view</h2><p>Try another time range or filter. Token history currently covers local Codex, Claude Code and Grok logs.</p><small>Missing history does not mean your account has used no tokens.</small></div> : <><TokenChart rows={rows} days={days} /><section className="aya-usage-breakdown"><div><h2>Model breakdown</h2><span>{modelRows.length} {modelRows.length === 1 ? 'model' : 'models'}</span></div><table><thead><tr><th>Model</th><th>Input</th><th>Output</th><th>Cache</th><th>Total</th></tr></thead><tbody>{modelRows.map(row => <tr key={row.provider + row.model}><th><button title="Filter by this model" onClick={() => { setProvider(row.provider); setModel(row.model); }}><strong>{row.model}</strong><small>{names[row.provider]}</small></button></th><td title={exact(row.input)}>{number(row.input)}</td><td title={exact(row.output)}>{number(row.output)}</td><td title={exact(row.cache)}>{number(row.cache)}</td><td title={exact(row.tokens)}>{number(row.tokens)}</td></tr>)}</tbody></table></section></>}
      <footer className="aya-usage-footnote">Local history · {history ? `${history.files.toLocaleString()} log files · Updated ${new Date(history.scannedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Not yet scanned'}<span>Cached input is counted once. Reasoning is included in output, not added again. Accounts reflect local history directories; shared directories count once. Limits are account-wide and may include other devices.</span></footer>
    </> : <>{limitsError && <div className="aya-usage-notice" role="alert">{limitsError}</div>}<div className="aya-usage-limits-intro"><h2>Account limits</h2><p>Provider-reported allowance. Shared by every session using the account.</p></div><div className="aya-usage-limit-grid">{limitGroups.flatMap(group => group.accounts.map(a => <LimitCard key={group.name + a.id} provider={group.name} account={a} />))}{limitData.grok?.limit && <LimitCard provider="Grok" account={{ id: 'grok', label: 'Grok', usage: { sevenDay: { pct: limitData.grok.limit.pct, resetsAt: limitData.grok.limit.resetsAt }, updatedAt: limitData.grok.limit.updatedAt } }} />}</div>{!limitGroups.some(group => group.accounts.length) && !limitData.grok?.limit && <div className="aya-usage-empty"><Icon name="speed" /><h2>No limit snapshots available</h2><p>Run a signed-in harness to refresh its own usage data. Claude limits use Aya’s optional usage hook.</p><small>API-key accounts may not report subscription limits.</small></div>}<footer className="aya-usage-footnote">Aya displays existing provider snapshots. Unknown limits remain unknown; token totals are not converted into subscription percentages.</footer></>}
    </div>
  </div>;
}
function TokenChart({ rows, days }: { rows: TokenUsageRow[]; days: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const buckets = useMemo(() => {
    const map = new Map<string, { input: number; output: number; cache: number }>();
    for (const row of rows) { const item = map.get(row.bucket) || { input: 0, output: 0, cache: 0 }; item.input += row.input; item.output += row.output; item.cache += row.cacheRead + row.cacheWrite; map.set(row.bucket, item); }
    const now = new Date(), start = new Date(now);
    if (days === 1) { start.setMinutes(0, 0, 0); start.setHours(start.getHours() - 24); } else { start.setHours(0, 0, 0, 0); start.setDate(start.getDate() - days); }
    const out = [];
    for (const date = new Date(start); date <= now;) { out.push({ bucket: date.toISOString(), ...(map.get(date.toISOString()) || { input: 0, output: 0, cache: 0 }) }); if (days === 1) date.setHours(date.getHours() + 1); else date.setDate(date.getDate() + 1); }
    return out;
  }, [rows, days]);
  const max = Math.max(1, ...buckets.map(b => b.input + b.output + b.cache));
  const selected = hover === null ? null : buckets[hover];
  const label = (bucket: string) => new Date(bucket).toLocaleString([], days === 1 ? { month: 'short', day: 'numeric', hour: '2-digit' } : { month: 'short', day: 'numeric' });
  return <section className="aya-usage-chart" aria-label="Token usage over time"><div className="aya-usage-chart-heading"><h2>Tokens over time</h2><div className="aya-usage-legend"><span data-type="input">Input</span><span data-type="output">Output</span><span data-type="cache">Cache</span></div></div><div className="aya-usage-chart-readout" aria-live="polite">{selected ? <><strong>{label(selected.bucket)}</strong><span>{exact(selected.input + selected.output + selected.cache)} tokens</span><small>Input {number(selected.input)} · Output {number(selected.output)} · Cache {number(selected.cache)}</small></> : <span>Hover or focus a bar to inspect its token counts.</span>}</div><div className="aya-usage-plot"><div className="aya-usage-y-axis"><span>{number(max)}</span><span>{number(max / 2)}</span><span>0</span></div><div className="aya-usage-bars" onMouseLeave={() => setHover(null)}>{buckets.map((b, i) => <button key={b.bucket} aria-label={`${label(b.bucket)}: ${exact(b.input + b.output + b.cache)} tokens`} onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)} data-selected={hover === i} style={{ '--bar-input': `${b.input / max * 100}%`, '--bar-output': `${b.output / max * 100}%`, '--bar-cache': `${b.cache / max * 100}%` } as React.CSSProperties}><span className="aya-usage-bar-cache" /><span className="aya-usage-bar-output" /><span className="aya-usage-bar-input" /></button>)}</div></div><div className="aya-usage-x-axis"><span>{label(buckets[0].bucket)}</span><span>{label(buckets[Math.floor(buckets.length / 2)].bucket)}</span><span>{label(buckets[buckets.length - 1].bucket)}</span></div></section>;
}
function LimitCard({ provider, account }: { provider: string; account: UsageAccount }) {
  const [, tick] = useState(0);
  useEffect(() => { const timer = setInterval(() => tick(value => value + 1), 60000); return () => clearInterval(timer); }, []);
  const age = Date.now() - Date.parse(account.usage.updatedAt), stale = !Number.isFinite(age) || age > USAGE_STALE_AFTER_MS;
  return <article className="aya-usage-limit-card"><header><div><small>{provider}</small><h3>{account.label}</h3></div><span className={stale ? 'stale' : ''}>{stale ? 'Last reported' : 'Latest snapshot'}</span></header>{([{ label: 'Session window', value: account.usage.fiveHour }, { label: 'Weekly window', value: account.usage.sevenDay }]).map(({ label, value }) => { const expired = value?.resetsAt && Date.parse(value.resetsAt) < Date.now(); return <div className="aya-usage-limit-window" key={label}><div><span>{label}</span><strong>{value ? `${Math.round(value.pct)}% used` : 'Not reported'}</strong></div>{value && <><div className="aya-usage-limit-track" data-high={value.pct >= 85}><span style={{ width: `${Math.min(100, value.pct)}%` }} /></div><small>{value.resetsAt ? expired ? 'Reset time passed · awaiting a new snapshot' : `Resets ${new Date(value.resetsAt).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}` : 'Reset time not reported'}</small></>}</div>; })}<footer>Updated {new Date(account.usage.updatedAt).toLocaleString()}</footer></article>;
}
