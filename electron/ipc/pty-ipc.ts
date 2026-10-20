// Terminal IPC: spawning, typing into, resizing, restarting and closing panes, reading their buffer and cwd,
// searching buffers and agent transcripts, and the host itself (restart, stop the others). What a spawn needs
// prepared, how the user's Enter is noted, and how the host is replaced stay with their owners in main.ts.

import type { IpcMain } from "electron";
import { PTY_HOST_NOT_CONNECTED, PTY_HOST_UNKNOWN_REQUEST } from "../constants";
import { searchHarnessSessions } from "../harness-search";
import { notePaneInput, withPaneInputLock } from "../pane-input-queue";
import type { PtyHostClient } from "../pty-host-client";
import { closePane, type createSpawnGate } from "../spawn-gate";
import type { SpawnRequest } from "../types";
import { requirePositiveInt, requireString, validateSpawnRequest } from "../validation";

export interface PtyIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  host: Pick<PtyHostClient, "write" | "resize" | "kill" | "getBuffer" | "getCwd" | "search" | "getSize">;
  gate: ReturnType<typeof createSpawnGate>;
  /** Shared-dir command, the agent brief, Aya Dev's own CLI first. */
  prepareSpawn: (req: SpawnRequest) => Promise<SpawnRequest>;
  /** Hands the prepared spawn to the host. */
  sendSpawn: (req: SpawnRequest) => Promise<boolean>;
  /** Removes the brief files written for a pane. */
  forgetBrief: (ptyId: string) => Promise<void>;
  /** Explicit replacement invalidates only this pane's unapplied display. */
  forgetDisplay?: (ptyId: string) => void;
  hasDisplay?: (ptyId: string) => boolean;
  /** The user's typing reached a pane: an Enter that answers a waiting agent drops its status in every window. */
  noteTyping: (ptyId: string, text: string) => Promise<void>;
  /** Asks before restarting a pane whose work the restart would stop. */
  confirmRestartPane: (ptyId: string) => Promise<boolean>;
  /** Replaces the host after asking; throws when cancelled or when the old host did not exit. */
  restartHost: () => Promise<void>;
  retryRecovery?:()=>Promise<boolean>;
  /** Stops running hosts Aya does not use, after asking; the pids signalled. */
  stopOtherHosts: () => Promise<number[]>;
  /** Questions agents are waiting on. */
  waiting: () => unknown;
}

export function registerPtyIpc(deps: PtyIpcDeps): void {
  const { ipcMain, host, gate } = deps;
  ipcMain.handle("pty:spawn", (_e, req: unknown) => {
    const validated = validateSpawnRequest(req);
    return gate.spawn(validated.ptyId, () => deps.prepareSpawn(validated), prepared => {
      // Keep cleanup authority while preparation can still be cancelled. The
      // gate invokes send only for a surviving explicit request.
      if (!validated.attachOnly && !validated.attachIfReused && !validated.replayAfter) deps.forgetDisplay?.(validated.ptyId);
      return deps.sendSpawn(prepared);
    }).then(async (sent) => {
      // Closed while preparing: the brief files it wrote after the close are no one's.
      if (sent === undefined && !gate.spawning(validated.ptyId)) await deps.forgetBrief(validated.ptyId).catch(() => {});
    });
  });
  // One write per pane at a time: the Enter that answers a waiting agent asks the host about the screen first, and
  // the keys typed right after it must not overtake it.
  ipcMain.handle("pty:write", (_e, ptyId: unknown, data: unknown) => {
    const id = requireString(ptyId, "pty:write.ptyId");
    const text = requireString(data, "pty:write.data");
    // Record the user's input intent before it can wait behind another write;
    // an attachment upload must not overtake text already queued by the pane.
    notePaneInput(id);
    return withPaneInputLock(id, async () => {
      await gate.afterSpawn(id);
      await deps.noteTyping(id, text);
      return host.write(id, text);
    });
  });
  ipcMain.handle(
    "pty:resize",
    async (_e, ptyId: unknown, cols: unknown, rows: unknown) =>
      host.resize(
        requireString(ptyId, "pty:resize.ptyId"),
        requirePositiveInt(cols, "pty:resize.cols"),
        requirePositiveInt(rows, "pty:resize.rows"),
      ),
  );
  ipcMain.handle("pty:confirm-restart", async (_e, ptyId: unknown) =>
    deps.confirmRestartPane(requireString(ptyId, "pty:confirm-restart.ptyId")),
  );
  ipcMain.handle("pty:kill", async (_e, ptyId: unknown) => {
    const id = requireString(ptyId, "pty:kill.ptyId");
    await closePane(gate, id, {
      // An ended restored pane still owns replay/outcome state and its idle
      // owner hold, even though it no longer has a live PTY size.
      hasPane: async (paneId) => (await host.getSize(paneId)) !== null || !!deps.hasDisplay?.(paneId),
      kill: (paneId) => host.kill(paneId),
    });
    deps.forgetDisplay?.(id);
    await deps.forgetBrief(id).catch(() => {});
  });
  ipcMain.handle("pty:buffer", async (_e, ptyId: unknown) => {
    try {
      return await host.getBuffer(requireString(ptyId, "pty:buffer.ptyId"));
    } catch (err) {
      if (
        err instanceof Error &&
        [PTY_HOST_UNKNOWN_REQUEST, PTY_HOST_NOT_CONNECTED].some((m) => err.message.includes(m))
      ) {
        return "";
      }
      throw err;
    }
  });
  // Live cwd of a terminal's process (null when unavailable) - the client
  // already turns an old host's "unknown request" into null.
  ipcMain.handle("pty:cwd", async (_e, ptyId: unknown) =>
    host.getCwd(requireString(ptyId, "pty:cwd.ptyId")),
  );
  ipcMain.handle("pty:search", async (_e, query: unknown) =>
    host.search(requireString(query, "pty:search.query")),
  );
  ipcMain.handle("harness:search", async (_e, req: unknown) => {
    if (typeof req !== "object" || req === null) {
      throw new Error("harness:search: request must be an object");
    }
    const r = req as Record<string, unknown>;
    const agent = requireString(r.agent, "harness:search.agent");
    if (agent !== "claude" && agent !== "codex") {
      throw new Error("harness:search.agent must be 'claude' or 'codex'");
    }
    return searchHarnessSessions({
      agent,
      cwd: requireString(r.cwd, "harness:search.cwd"),
      configDir:
        r.configDir === undefined
          ? undefined
          : requireString(r.configDir, "harness:search.configDir"),
      command: r.command === undefined ? undefined : requireString(r.command, "harness:search.command"),
      query: requireString(r.query, "harness:search.query"),
    });
  });
  ipcMain.handle("pty-host:restart", async () => deps.restartHost());
  ipcMain.handle("pty-host:retry-recovery",async()=>deps.retryRecovery?.()??false);
  // Asked in main, not in the window: Aya Web reaches this handler too.
  ipcMain.handle("pty-host:stop-others", async () => deps.stopOtherHosts());
  ipcMain.handle("agent:waiting", () => deps.waiting());
}
