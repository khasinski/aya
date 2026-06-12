import type { BufferSearchHit } from "./pty";
import type { PtyEvent, SpawnRequest } from "./types";

export type PtyHostRequest =
  | { id: number; type: "spawn"; req: SpawnRequest }
  | { id: number; type: "write"; ptyId: string; data: string }
  | { id: number; type: "resize"; ptyId: string; cols: number; rows: number }
  | { id: number; type: "kill"; ptyId: string }
  | { id: number; type: "shutdown" }
  | { id: number; type: "search"; query: string }
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

export function asSearchResult(value: unknown): BufferSearchHit[] {
  return Array.isArray(value) ? (value as BufferSearchHit[]) : [];
}
