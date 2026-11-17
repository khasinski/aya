const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const label = (value: string) => value.replace(/\s+/g, ' ').replace(/[\\`*_{}\[\]()<>#+.!|~]/g, '\\$&');
const count = (value: number) => value.toLocaleString('en-US');

/** Display the connected Claude account's native usage, without reading credentials. */
export function formatClaudeUsage(value: unknown): string {
  const usage = record(value), session = record(usage.session);
  if (!number(session.total_cost_usd) || typeof usage.rate_limits_available !== 'boolean') {
    throw Error('Claude Code returned an unsupported usage response. Update Claude Code and reconnect.');
  }
  const lines = ['### Claude usage', '', '#### Plan limits · account-wide', ''];
  if (typeof usage.subscription_type === 'string') lines.push(`Plan: ${label(usage.subscription_type)}`, '');
  const rates = record(usage.rate_limits);
  const windows: Array<[string, unknown]> = [
    ['5-hour window', rates.five_hour], ['7-day window', rates.seven_day],
    ['7-day Opus', rates.seven_day_opus], ['7-day Sonnet', rates.seven_day_sonnet],
    ['7-day OAuth apps', rates.seven_day_oauth_apps],
  ];
  if (Array.isArray(rates.model_scoped)) for (const raw of rates.model_scoped) {
    const window = record(raw);
    if (typeof window.display_name === 'string' && !windows.some(([name]) => name === `7-day ${window.display_name}`)) windows.push([`7-day ${window.display_name}`, window]);
  }
  if (record(rates.extra_usage).is_enabled === true) windows.push(['Extra usage', rates.extra_usage]);
  let shown = 0;
  if (usage.rate_limits_available) for (const [name, raw] of windows) {
    if (!raw || typeof raw !== 'object') continue;
    const window = record(raw), reset = typeof window.resets_at === 'string' ? new Date(window.resets_at) : null;
    lines.push(`- ${label(name)}: ${number(window.utilization) ? `${Number(window.utilization.toFixed(1))}% used` : 'Unavailable'}${reset && Number.isFinite(reset.getTime()) ? ` · resets ${reset.toLocaleString()}` : ''}`);
    shown++;
  }
  if (!shown) lines.push('Plan limits unavailable. They may not apply to this account, or Claude Code could not retrieve them.');
  lines.push('', '#### Current session', '', `- API-equivalent cost: $${session.total_cost_usd.toFixed(4)} USD`, '- This estimate is not a subscription charge.');
  const models = record(session.model_usage);
  for (const [name, raw] of Object.entries(models)) {
    const model = record(raw);
    const fields = [['inputTokens', 'input'], ['outputTokens', 'output'], ['cacheReadInputTokens', 'cache read'], ['cacheCreationInputTokens', 'cache write']] as const;
    const tokens = fields.filter(([key]) => number(model[key])).map(([key, title]) => `${count(model[key] as number)} ${title}`);
    if (tokens.length) lines.push(`- ${label(name)}: ${tokens.join(' · ')} tokens`);
  }
  if (!session.model_usage || typeof session.model_usage !== 'object' || Array.isArray(session.model_usage)) lines.push('- Model token usage unavailable.');
  else if (!Object.keys(models).length) lines.push('- No model token usage recorded in this session.');
  return lines.join('\n');
}
