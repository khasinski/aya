// In-process adapter for the PTY core. The detached host imports pty-core directly.
import type { SpawnRequest } from "./types";
import { spawnPty as spawnCore, getPtyPid, type PtyEventSink } from "./pty-core";
import { prepareSpawn, watchAgentSession } from "./pty-prepare";
import { openVtPane, vtPaneWaiting, vtPaneDialog } from "./vt-state";
import { getProcessCwd } from "./process-cwd";
export * from "./pty-core";
export { safeEnv, shellArgv, agentConfigDirsFromCommand } from "./pty-prepare";
export function spawnPty(req: SpawnRequest, sink: PtyEventSink): Promise<void> {
  return spawnCore(req, sink, {
    prepare: prepareSpawn,
    openMirror: openVtPane,
    replay: (req, _pid, _at, sink) => {
      if (vtPaneWaiting(req.ptyId) && !sink.isDestroyed())
        sink.sendPtyEvent({ type: "vt-status", ptyId: req.ptyId, waiting: true, ...(vtPaneDialog(req.ptyId) ? { dialog: vtPaneDialog(req.ptyId) } : {}) });
    },
    opened: (req, pid, data, sink) => watchAgentSession(req, data.launch.cwd, pid, data.spawnedAt,
      (sessionId) => sink.sendPtyEvent({ type: "osc-session", ptyId: req.ptyId, sessionId })),
  });
}
export async function getPtyCwd(id: string): Promise<string | null> {
  const pid = getPtyPid(id);
  return typeof pid === "number" ? getProcessCwd(pid) : null;
}
