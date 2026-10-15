import type { PreparedSpawn } from "./pty-core";
import type { VtSnapshot } from "./vt-mirror";
import type { PaneSize } from "./pane-render";
import type { BufferSearchHit } from "./pty";
import type { PtyEvent, SpawnRequest } from "./types";
import type { CheckpointReceipt } from "./pty-checkpoint-store";

export type PtyHostRequest =
  | { id: number; type: "spawn"; req: SpawnRequest }
  | { id: number; type: "write"; ptyId: string; data: string }
  | { id: number; type: "resize"; ptyId: string; cols: number; rows: number }
  | { id: number; type: "kill"; ptyId: string }
  | { id: number; type: "shutdown" }
  | { id: number; type: "search"; query: string }
  | { id: number; type: "buffer"; ptyId: string }
  // Live cwd of a PTY's child. Added after 0.7.8: a host from an older build
  // answers "unknown request", which the client turns back into null.
  | { id: number; type: "cwd"; ptyId: string }
  // The pane's process, to prove who runs an `aya team` command. An older host
  // answers "unknown request", which the client turns into undefined (cannot say).
  | { id: number; type: "pid"; ptyId: string }
  // Why a message must not be typed into the pane now (vt-state paneHold).
  | { id: number; type: "hold"; ptyId: string; pasted?: string }
  // Whether the pane's agent is mid-turn (vt-state paneBusy). Added after 0.12.0; an older host
  // answers "unknown request", which the client turns into false.
  | { id: number; type: "busy"; ptyId: string }
  | { id: number; type: "launch"; ptyId: string }
  // Live cols x rows + alt screen, for `aya pane read`'s render. Added after 0.11.0; an
  // older host answers "unknown request", which the client turns into null.
  | { id: number; type: "size"; ptyId: string }
  | { id: number; type: "snapshot"; ptyId: string }
  | { id: number; type: "composer-seen"; ptyId: string; generation: string }
  | { id: number; type: "prepared"; prepareId: number; data: PreparedSpawn }
  | { id: number; type: "handover-announce"; nonce: string; deadline: number }
  | { id: number; type: "handover-prepare"; deadline: number }
  | { id: number; type: "handover-publish"; display: CheckpointReceipt | null }
  | { id: number; type: "handover-cancel" }
  | { id: number; type: "handover-claim"; nonce: string }
  | { id: number; type: "version" };

export type PtyHostResponse = (
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string }) & { ownerBacked?: true; hostPid?: number };

export interface PtyOwnerStatus {
  pid: number;
  incompatible: boolean;
  disconnected: string[];
  inventory?: Array<{ id: string; pid: number; startIdentity?: string | null }>;
  uncertain?: string[];
  recoveryFailures?: string[];
}

export type PtyHostEventMessage = { type: "event"; event: PtyEvent };

export type PtyHostPrepareMessage = { type: "prepare"; prepareId: number; req: SpawnRequest; cwd: string };
export type PtyHostSnapshotMessage = { type: "snapshot"; ptyId: string; snapshot: VtSnapshot; replay?: true };
export type PtyHostSpawnedMessage = { type: "spawned"; req: SpawnRequest; pid: number; cwd: string; spawnedAt: number };
export type PtyHostMessage = PtyHostResponse | PtyHostEventMessage | PtyHostPrepareMessage | PtyHostSnapshotMessage | PtyHostSpawnedMessage | { type: "cancel-prepare"; prepareId: number };

export function isPtyHostRequest(value: unknown): value is PtyHostRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PtyHostRequest>;
  return typeof r.id === "number" && typeof r.type === "string";
}

export function asPaneSize(value: unknown): PaneSize | null {
  const v = value as Partial<PaneSize> | null;
  if (typeof v?.cols !== "number" || typeof v.rows !== "number") return null;
  const size: PaneSize = { cols: v.cols, rows: v.rows };
  if (typeof v.alt === "boolean") size.alt = v.alt;
  return size;
}

export function asSearchResult(value: unknown): BufferSearchHit[] {
  return Array.isArray(value) ? (value as BufferSearchHit[]) : [];
}

/** A malformed mirror is unknown, never permission to type into a dialog. */
export function asVtSnapshot(value: unknown): VtSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const s = value as VtSnapshot;
  if (typeof s.generation !== "string" || typeof s.shell !== "boolean" ||
      typeof s.composerSeen !== "boolean" || typeof s.openedAt !== "number" ||
      !(s.lastOutputAt === null || typeof s.lastOutputAt === "number") ||
      !Number.isInteger(s.cols) || s.cols < 1 ||
      !Array.isArray(s.rows) || !s.rows.every((r) => typeof r === "string") ||
      !Array.isArray(s.cells) || s.cells.length !== s.rows.length ||
      !s.cells.every((row) => Array.isArray(row) && row.every((c) =>
        Array.isArray(c) && c.length === 4 && Number.isInteger(c[0]) && c[0] >= 0 && c[0] < s.cols &&
        typeof c[1] === "string" && typeof c[2] === "number" && typeof c[3] === "number"))) return null;
  return s;
}
