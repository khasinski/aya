import type { PaneSize } from "./pane-render";
import type { BufferSearchHit } from "./pty";
import type { PtyEvent, SpawnRequest } from "./types";

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
  // Live cols x rows + alt screen, for `aya pane read`'s render. Added after 0.11.0; an
  // older host answers "unknown request", which the client turns into null.
  | { id: number; type: "size"; ptyId: string }
  | { id: number; type: "version" };

export type PtyHostResponse =
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string };

export type PtyHostEventMessage = { type: "event"; event: PtyEvent };

export type PtyHostMessage = PtyHostResponse | PtyHostEventMessage;

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
