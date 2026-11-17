type ChromeRequest = (subtype: string, payload?: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Chrome stays owned by Claude Code: use its status, policies and MCP controls. */
export async function claudeChromeCommand(argument: string, request: ChromeRequest): Promise<{ text: string }> {
  const action = argument.trim().toLowerCase() || 'status';
  if (!['status', 'on', 'off', 'reconnect'].includes(action)) {
    throw Error('Usage: /chrome [status|on|off|reconnect]');
  }
  const read = async () => {
    let status: Record<string, unknown>;
    try { status = await request('get_chrome_dialog'); }
    catch (error) { throw Error(`Could not read Chrome status: ${error instanceof Error ? error.message : String(error)}. If unsupported, update Claude Code and reconnect.`); }
    if (!['allowed', 'subscriber', 'wsl', 'installed', 'connected', 'enabled_by_default'].every(key => typeof status[key] === 'boolean')) {
      throw Error('Claude Code returned an unsupported Chrome status. Update Claude Code and reconnect.');
    }
    return status;
  };
  let status = await read();
  if (action === 'on' || action === 'reconnect') {
    if (!status.allowed) throw Error('Chrome access is disabled by your organization’s policy.');
    if (!status.subscriber) throw Error('Chrome requires a Claude subscription signed in with /login in Claude Code. API keys and setup tokens cannot use the extension.');
    if (status.wsl) throw Error('Claude in Chrome is not supported in WSL.');
    if (!status.installed) throw Error('Install and sign in to the Claude in Chrome extension, then run /chrome reconnect.');
  }
  if (action === 'on' || action === 'off') {
    await request('mcp_toggle', { serverName: 'claude-in-chrome', enabled: action === 'on' });
    status = await read();
  } else if (action === 'reconnect') {
    await request('mcp_reconnect', { serverName: 'claude-in-chrome' });
    status = await read();
  }
  return { text: [
    '### Claude in Chrome',
    '',
    `- Connection: ${status.connected ? 'Connected' : 'Not connected'}`,
    `- Extension: ${status.installed ? 'Installed' : 'Not detected'}`,
    `- Access: ${!status.allowed ? 'Disabled by organization policy' : !status.subscriber ? 'Sign in with a Claude subscription' : status.wsl ? 'Unavailable in WSL' : 'Available'}`,
    ...(typeof status.paired_browser === 'string' ? [`- Browser: ${status.paired_browser}`] : []),
    `- Default for Claude CLI sessions: ${status.enabled_by_default ? 'On' : 'Off'}`,
    '',
    '`/chrome on` · `/chrome off` · `/chrome reconnect`',
    '',
    'Site permissions are managed in the Chrome extension.',
  ].join('\n') };
}
