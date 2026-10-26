// Terminal IPC: spawning, typing into, resizing, restarting and closing panes, reading their buffer and cwd,
// searching buffers and agent transcripts, and the host itself (restart, stop the others). What a spawn needs
// prepared, how the user's Enter is noted, and how the host is replaced stay with their owners in main.ts.

import type { IpcMain } from "electron";
import { PTY_HOST_NOT_CONNECTED, PTY_HOST_UNKNOWN_REQUEST } from "../constants";
import { searchHarnessSessions } from "../harness-search";
import { notePaneInput, withPaneInputLock } from "../pane-input-queue";
import type { PtyHostClient } from "../pty-host-client";
import { closePane, type createSpawnGate } from "../spawn-gate";
import type { HarnessSearchRequest, SpawnRequest } from "../types";
import { requirePositiveInt, requireString, validateSpawnRequest } from "../validation";

export interface PtyIpcDeps {
  ipcMain: Pick<IpcMain, "handle"> & Partial<Pick<IpcMain, "on">>;
  host: Pick<PtyHostClient, "write" | "resize" | "kill" | "getBuffer" | "getCwd" | "search" | "getSize">;
  remote?: {
    write: (ptyId: string, data: string) => Promise<boolean | undefined>;
    resize: (ptyId: string, cols: number, rows: number) => Promise<boolean>;
    detach: (ptyId: string) => Promise<boolean>;
    end: (ptyId: string) => Promise<boolean>;
    reconnect: (ptyId: string) => Promise<boolean>;
    acknowledgeOutput: (ptyId: string, deliveryId: string, sinkId: number) => boolean;
  };
  gate: ReturnType<typeof createSpawnGate>;
  /** Shared-dir command, the agent brief, Aya Dev's own CLI first. */
  prepareSpawn: (req: SpawnRequest) => Promise<SpawnRequest>;
  /** Hands the prepared spawn to the host. */
  sendSpawn: (req: SpawnRequest) => Promise<boolean>;
  /** Refuses new terminals while an update handover is being prepared. */
  assertSpawnAllowed?: () => void;
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
  /** Optional override for deterministic cancellation tests. */
  searchHarness?: typeof searchHarnessSessions;
}

export function registerPtyIpc(deps: PtyIpcDeps): void {
  const { ipcMain, host, gate } = deps;
  const activeHarnessSearches = new Map<string, {
    requestId: string;
    senderId: number;
    paneId: string;
    controller: AbortController;
  }>();
  ipcMain.handle("pty:spawn", (_e, req: unknown) => {
    const validated = validateSpawnRequest(req);
    // This check belongs in main: remote spawns do not pass through
    // PtyHostClient.spawn, which has its own host-freeze refusal.
    deps.assertSpawnAllowed?.();
    return gate.spawn(validated.ptyId, () => deps.prepareSpawn(validated), prepared => {
      // Preparation can await filesystem/config work. Recheck before any
      // local or remote route is dispatched in case an update began meanwhile.
      deps.assertSpawnAllowed?.();
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
      const remoteResult = await deps.remote?.write(id, text);
      if (remoteResult !== undefined) return remoteResult;
      return host.write(id, text);
    });
  });
  ipcMain.handle(
    "pty:resize",
    async (_e, ptyId: unknown, cols: unknown, rows: unknown) => {
      const id = requireString(ptyId, "pty:resize.ptyId");
      const c = requirePositiveInt(cols, "pty:resize.cols");
      const r = requirePositiveInt(rows, "pty:resize.rows");
      if (await deps.remote?.resize(id, c, r)) return;
      return host.resize(id, c, r);
    },
  );
  ipcMain.handle("pty:confirm-restart", async (_e, ptyId: unknown) =>
    deps.confirmRestartPane(requireString(ptyId, "pty:confirm-restart.ptyId")),
  );
  ipcMain.handle("pty:remote-reconnect", (_e, ptyId: unknown) => deps.remote?.reconnect(requireString(ptyId, "pty:remote-reconnect.ptyId")) ?? false);
  ipcMain.on?.("pty:remote-output-ack", (event, ptyId: unknown, deliveryId: unknown) => {
    if (typeof ptyId === "string" && typeof deliveryId === "string") deps.remote?.acknowledgeOutput(ptyId, deliveryId, event.sender.id);
  });
  ipcMain.handle("pty:kill", async (_e, ptyId: unknown, action?: unknown) => {
    const id = requireString(ptyId, "pty:kill.ptyId");
    if (action === "end-remote" && await deps.remote?.end(id)) return;
    if (action !== "end-remote" && await deps.remote?.detach(id)) {
      deps.forgetDisplay?.(id);
      await deps.forgetBrief(id).catch(() => {});
      return;
    }
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
  ipcMain.handle("harness:search", async (event, req: unknown, rawRequestId: unknown, rawPaneId: unknown) => {
    if (typeof req !== "object" || req === null) {
      throw new Error("harness:search: request must be an object");
    }
    const requestId = requireString(rawRequestId, "harness:search.requestId");
    if (requestId.length > 256) throw new Error("harness:search.requestId is too long");
    const paneId = requireString(rawPaneId, "harness:search.paneId");
    if (paneId.length > 256) throw new Error("harness:search.paneId is too long");
    const r = req as Record<string, unknown>;
    const agent = requireString(r.agent, "harness:search.agent");
    if (agent !== "claude" && agent !== "codex") {
      throw new Error("harness:search.agent must be 'claude' or 'codex'");
    }
    const searchRequest: HarnessSearchRequest = {
      agent,
      cwd: requireString(r.cwd, "harness:search.cwd"),
      configDir:
        r.configDir === undefined
          ? undefined
          : requireString(r.configDir, "harness:search.configDir"),
      command: r.command === undefined ? undefined : requireString(r.command, "harness:search.command"),
      query: requireString(r.query, "harness:search.query"),
    };
    // Each find bar can run one scan. A newer query in that same pane stops
    // its prior work without cancelling searches in another pane/window.
    const senderId = event?.sender?.id ?? -1;
    const key = JSON.stringify([senderId, paneId]);
    activeHarnessSearches.get(key)?.controller.abort();
    const controller = new AbortController();
    const active = {
      requestId,
      senderId,
      paneId,
      controller,
    };
    activeHarnessSearches.set(key, active);
    try {
      return await (deps.searchHarness ?? searchHarnessSessions)(searchRequest, { signal: controller.signal });
    } finally {
      if (activeHarnessSearches.get(key) === active) activeHarnessSearches.delete(key);
    }
  });
  ipcMain.handle("harness:search-cancel", (event, rawRequestId: unknown, rawPaneId: unknown) => {
    const requestId = requireString(rawRequestId, "harness:search-cancel.requestId");
    const paneId = requireString(rawPaneId, "harness:search-cancel.paneId");
    const senderId = event?.sender?.id ?? -1;
    const key = JSON.stringify([senderId, paneId]);
    const active = activeHarnessSearches.get(key);
    if (active?.requestId === requestId && active.senderId === senderId && active.paneId === paneId) {
      active.controller.abort();
    }
  });
  ipcMain.handle("pty-host:restart", async () => deps.restartHost());
  ipcMain.handle("pty-host:retry-recovery",async()=>deps.retryRecovery?.()??false);
  // Asked in main, not in the window: Aya Web reaches this handler too.
  ipcMain.handle("pty-host:stop-others", async () => deps.stopOtherHosts());
  ipcMain.handle("agent:waiting", () => deps.waiting());
}
