import { readUsageHistory } from "../usage-history";
// Usage and agent-hook IPC: the Claude, Codex and Grok usage snapshots, the optional Claude usage hook, and the
// automatic-status hooks for Claude Code and Codex.

import type { IpcMain } from "electron";
import { listPresets } from "../presets";
import { installStatusHook, statusHookStatus, uninstallStatusHook, type StatusHookStatus } from "../status-hook";
import {
  installStatusCodexHook,
  statusCodexHookStatus,
  uninstallStatusCodexHook,
  type CodexStatusHookStatus,
} from "../status-hook-codex";
import { DEFAULT_CLAUDE_CONFIG_DIR, expandUserPath, readClaudeUsageAccounts } from "../usage";
import { codexUsageSources, readCodexUsageAccountsFromSources } from "../usage-codex";
import { readAntigravityUsage } from "../usage-antigravity";
import { DEFAULT_GROK_HOME, readGrokUsage } from "../usage-grok";
import { installUsageHook, uninstallUsageHook, usageHookStatus } from "../usage-hook";

/** Automatic status (#38) covers both agents under one toggle: `installed` stays Claude-driven (unchanged contract),
 *  and Codex rides along as a sub-status so the UI can disclose it (including "you already have a notify"). */
export function withCodexStatus<T extends object>(claude: T, codex: CodexStatusHookStatus): T & { codex: StatusHookStatus["codex"] } {
  return {
    ...claude,
    codex: {
      configured: codex.configured,
      conflict: codex.conflict,
      configPath: codex.configPath,
    },
  };
}

export function registerUsageIpc(ipcMain: Pick<IpcMain, "handle">): void {
  ipcMain.handle("usage:history", async (_event, days: unknown, refresh: unknown) => readUsageHistory(await listPresets(), days, refresh === true));
  // Read-only: the account-wide usage snapshot a user hook writes (no fetch).
  ipcMain.handle("usage:get", async () => {
    const presets = await listPresets();
    return readClaudeUsageAccounts(
      presets
        .filter((p) => p.agent === "claude")
        .map((p) => ({
          id: p.id,
          label: p.name,
          configDir: p.configDir || DEFAULT_CLAUDE_CONFIG_DIR,
        })),
    );
  });
  // Read-only: Codex usage, parsed from its own local rollout logs (Codex
  // writes its rate-limit % there, so no token/endpoint/hook is needed).
  ipcMain.handle("usage:get-codex", async () => {
    return readCodexUsageAccountsFromSources(codexUsageSources(await listPresets()));
  });
  // Read-only: 7-day spend and tokens, plus the weekly limit when Grok logged one.
  ipcMain.handle("usage:get-grok", async () => {
    const presets = await listPresets();
    const grokDirs = presets
      .filter((p) => p.agent === "grok" && p.configDir)
      .map((p) => expandUserPath(p.configDir as string));
    return readGrokUsage(grokDirs.length > 0 ? grokDirs : [DEFAULT_GROK_HOME]);
  });
  ipcMain.handle("usage:get-antigravity", async () => {
    const presets = await listPresets();
    return presets.some((p) => p.agent === "antigravity") ? readAntigravityUsage() : [];
  });
  // Optional, user-enabled usage hook installer (writes ~/.claude/settings.json
  // + a fetch script). The Aya process never reads a token or calls the
  // endpoint - that happens later in the script, run by Claude Code.
  ipcMain.handle("usage-hook:status", async () => usageHookStatus());
  ipcMain.handle("usage-hook:install", async () => installUsageHook());
  ipcMain.handle("usage-hook:uninstall", async () => uninstallUsageHook());
  // Automatic agent status (#38): Claude Code lifecycle hooks -> `aya status`, written to ~/.claude/settings.json,
  // and the Codex notify program; the generated scripts no-op outside Aya.
  ipcMain.handle("status-hook:status", async () => {
    const [claude, codex] = await Promise.all([statusHookStatus(), statusCodexHookStatus()]);
    return withCodexStatus(claude, codex);
  });
  ipcMain.handle("status-hook:install", async () => {
    const [claude, codex] = await Promise.all([installStatusHook(), installStatusCodexHook()]);
    return withCodexStatus(claude, codex);
  });
  ipcMain.handle("status-hook:uninstall", async () => {
    const [claude, codex] = await Promise.all([uninstallStatusHook(), uninstallStatusCodexHook()]);
    return withCodexStatus(claude, codex);
  });
}
