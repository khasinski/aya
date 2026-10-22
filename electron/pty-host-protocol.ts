import {validAuthTransferDeadline} from "./pty-host-auth-transfer";
import type { PreparedSpawn } from "./pty-core";
import { validVtSnapshotFence, type VtSnapshot, type VtSnapshotFence } from "./vt-mirror";
import type { PaneSize } from "./pane-render";
import type { BufferSearchHit } from "./pty";
import type { PtyEvent, SpawnRequest } from "./types";
import type { CheckpointReceipt } from "./pty-checkpoint-store";

export type PtyHostRequest =
  | { id: number; type: "spawn"; req: SpawnRequest }
  | { id: number; type: "write"; ptyId: string; data: string }
  // A separate verb makes an older host refuse rather than ignore a fence.
  // The opaque main-instance/provider epoch is checked again at the host's
  // queued first-byte boundary, independently of the VT revision fence.
  | { id: number; type: "write-fenced"; ptyId: string; data: string; fence: VtSnapshotFence; policyEpoch: string }
  | { id: number; type: "rule-policy-epoch"; epoch: string }
  | { id: number; type: "snapshot-check"; ptyId: string; fence: VtSnapshotFence }
  | { id: number; type: "composer-seen-checked"; ptyId: string; fence: VtSnapshotFence }
  | { id: number; type: "resize"; ptyId: string; cols: number; rows: number }
  | { id: number; type: "kill"; ptyId: string }
  | { id: number; type: "shutdown"; target?:{pid:number;startTime:string;ownerInstance:string|null} }
  | { id: number; type: "search"; query: string }
  | { id: number; type: "buffer"; ptyId: string }
  | { id: number; type: "remote-output"; ptyId: string }
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
  | { id:number;type:"auth-transfer-reserve";purpose:"ordinary-quit"|"planned-update";nonce:string;deadline:number|null }
  | { id:number;type:"auth-transfer-activate";attempt:string }
  | { id:number;type:"auth-transfer-cancel";attempt:string }
  | { id:number;type:"auth-transfer-complete";attempt:string;receipt:string }
  | { id: number; type: "handover-announce"; nonce: string; deadline: number;transferAttempt?:string }
  | {id:number;type:"handover-display-applied";ptyId:string;generation:string;token?:string}
  | { id: number; type: "handover-prepare"; deadline: number;transferAttempt?:string }
  | { id: number; type: "handover-publish"; display: CheckpointReceipt | null; consented?: string[];transferAttempt?:string }
  | { id: number; type: "handover-cancel";transferAttempt?:string }
  | { id: number; type: "handover-claim"; nonce: string; reuse?: boolean; transferAttempt?:string }
  | { id: number; type: "handover-detach"; consented: string[] }
  | { id: number; type: "handover-reuse" }
  | { id: number; type: "handover-ack-reuse" }
  | { id:number;type:"exit-observed";ptyId:string;generation:number;event:number }
  | { id: number; type: "owner-continuity"; transferAttempt?:string }
  | { id: number; type: "version" };

export type PtyHostResponse = (
  | { id: number; ok: true; result?: unknown }
  | { id: number; ok: false; error: string; code?: "PTY_HOST_STALE_REVISION"|"PTY_HOST_RULES_CHANGED" }) & { ownerBacked?: true; hostPid?: number;ownerIdentity?: import("./pty-owner-runtime").RecoveryOwnerIdentity&{incompatible:boolean} };

export interface PtyOwnerStatus {
  pid: number;
  startIdentity?:string;
  instanceId?:string;
  startTime?:string;
  incompatible: boolean;
  hash?: string;
  disconnected: string[];
  inventory?: Array<{ id: string; pid: number; startIdentity?: string | null }>;
  uncertain?: string[];
  recoveryFailures?: string[];
}

export type PtyHostEventMessage = { type: "event"; event: PtyEvent };

export type PtyHostPrepareMessage = { type: "prepare"; prepareId: number; req: SpawnRequest; cwd: string };
export type PtyHostSnapshotMessage = { type: "snapshot"; ptyId: string; snapshot: VtSnapshot; replay?: true };
export type PtyHostSpawnedMessage = { type: "spawned"; req: SpawnRequest; pid: number; cwd: string; spawnedAt: number; ownerIdentity?: import("./pty-owner-runtime").RecoveryOwnerIdentity&{incompatible:boolean};launch?: import("./launch-mode").PaneLaunch;restored?:true;ownerBacked?:true;hostPid?:number };
export type PtyHostMessage = PtyHostResponse | PtyHostEventMessage | PtyHostPrepareMessage | PtyHostSnapshotMessage | PtyHostSpawnedMessage | { type: "cancel-prepare"; prepareId: number };

export function isPtyHostRequest(value: unknown): value is PtyHostRequest {
  if (!value || typeof value !== "object") return false;
  const r = value as Partial<PtyHostRequest>;
  if(typeof r.type==="string"&&r.type.startsWith("auth-transfer-")){
    const keys=r.type==="auth-transfer-reserve"?["id","type","purpose","nonce","deadline"]:r.type==="auth-transfer-complete"?["id","type","attempt","receipt"]:["id","type","attempt"];
    const record=value as Record<string,unknown>,hex=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
    if(!["auth-transfer-reserve","auth-transfer-activate","auth-transfer-cancel","auth-transfer-complete"].includes(r.type)||!Number.isSafeInteger(r.id)||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))return false;
    return r.type==="auth-transfer-reserve"?hex(record.nonce)&&validAuthTransferDeadline(record.purpose,record.deadline):hex(record.attempt)&&(r.type!=="auth-transfer-complete"||hex(record.receipt));
  }
  if(["handover-prepare","handover-publish","handover-cancel","handover-announce"].includes(r.type??"")&&Object.hasOwn(value,"transferAttempt")){
    const v=value as Record<string,unknown>,keys=r.type==="handover-prepare"?["id","type","deadline","transferAttempt"]:r.type==="handover-publish"?["id","type","display","consented","transferAttempt"]:r.type==="handover-announce"?["id","type","nonce","deadline","transferAttempt"]:["id","type","transferAttempt"];
    if(!Number.isSafeInteger(v.id)||Object.keys(v).length!==keys.length||!keys.every(key=>Object.hasOwn(v,key))||typeof v.transferAttempt!=="string"||!/^[a-f0-9]{64}$/.test(v.transferAttempt))return false;
    return (r.type!=="handover-prepare"&&r.type!=="handover-announce"||Number.isSafeInteger(v.deadline))&&(r.type!=="handover-announce"||typeof v.nonce==="string"&&/^[a-f0-9]{64}$/.test(v.nonce));
  }
  if(r.type==="handover-claim"&&Object.hasOwn(value,"transferAttempt")){
    const v=value as Record<string,unknown>;
    return Object.keys(v).sort().join(",")==="id,nonce,reuse,transferAttempt,type"&&Number.isSafeInteger(v.id)&&typeof v.reuse==="boolean"&&typeof v.nonce==="string"&&/^[a-f0-9]{64}$/.test(v.nonce)&&typeof v.transferAttempt==="string"&&/^[a-f0-9]{64}$/.test(v.transferAttempt);
  }
  if(r.type==="owner-continuity"&&Object.hasOwn(value,"transferAttempt")){
    const record=value as Record<string,unknown>;
    return Number.isSafeInteger(r.id)&&Object.keys(value).length===3&&["id","type","transferAttempt"].every(key=>Object.hasOwn(value,key))&&typeof record.transferAttempt==="string"&&/^[a-f0-9]{64}$/.test(record.transferAttempt);
  }
  if (r.type === "write-fenced" || r.type === "snapshot-check" || r.type === "composer-seen-checked") {
    const keys = r.type === "write-fenced" ? ["id", "type", "ptyId", "fence", "data", "policyEpoch"] : ["id", "type", "ptyId", "fence"];
    return Number.isSafeInteger(r.id) && typeof r.ptyId === "string" && r.ptyId.length > 0 && r.ptyId.length <= 256 &&
      Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)) && validVtSnapshotFence(r.fence) &&
      (r.type !== "write-fenced" || typeof r.data === "string" && typeof r.policyEpoch === "string" && /^[a-f0-9]{32}:[0-9]{1,16}$/.test(r.policyEpoch));
  }
  if (r.type === "rule-policy-epoch") return Number.isSafeInteger(r.id) && Object.keys(value).length === 3 && ["id", "type", "epoch"].every(key => Object.hasOwn(value, key)) && typeof (value as {epoch?:unknown}).epoch === "string" && /^[a-f0-9]{32}:[0-9]{1,16}$/.test((value as {epoch:string}).epoch);
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

/** Return a safe, field-specific reason when a host screen DTO is malformed. */
export function vtSnapshotValidationError(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "snapshot is not an object";
  const s = value as VtSnapshot;
  if (typeof s.generation !== "string") return "generation is not a string";
  if (s.revision !== undefined && !validVtSnapshotFence({ generation: s.generation, revision: s.revision })) return "revision is invalid";
  if (typeof s.shell !== "boolean") return "shell flag is not boolean";
  if (s.recoveryUnknown !== undefined && typeof s.recoveryUnknown !== "boolean") return "recoveryUnknown is not boolean";
  if (typeof s.composerSeen !== "boolean") return "composerSeen is not boolean";
  if (typeof s.openedAt !== "number" || !Number.isFinite(s.openedAt)) return "openedAt is not finite";
  if (!(s.lastOutputAt === null || (typeof s.lastOutputAt === "number" && Number.isFinite(s.lastOutputAt)))) return "lastOutputAt is not finite or null";
  if (!Number.isInteger(s.cols) || s.cols < 1) return "cols is not a positive integer";
  if (!Array.isArray(s.rows)) return "rows is not an array";
  for (let y = 0; y < s.rows.length; y++) if (typeof s.rows[y] !== "string") return `rows[${y}] is not a string`;
  if (!Array.isArray(s.cells)) return "cells is not an array";
  if (s.cells.length !== s.rows.length) return `cells/rows length mismatch (${s.cells.length}/${s.rows.length})`;
  for (let y = 0; y < s.cells.length; y++) {
    const row = s.cells[y];
    if (!Array.isArray(row)) return `cells[${y}] is not an array`;
    for (let x = 0; x < row.length; x++) {
      const c = row[x];
      if (!Array.isArray(c) || c.length !== 4) return `cells[${y}][${x}] is not a four-field cell`;
      if (!Number.isInteger(c[0]) || c[0] < 0 || c[0] >= s.cols) return `cells[${y}][${x}].column is outside 0..${s.cols - 1}`;
      if (typeof c[1] !== "string") return `cells[${y}][${x}].text is not a string`;
      if (typeof c[2] !== "number" || !Number.isFinite(c[2])) return `cells[${y}][${x}].dim is not finite`;
      if (typeof c[3] !== "number" || !Number.isFinite(c[3])) return `cells[${y}][${x}].inverse is not finite`;
    }
  }
  return null;
}

/** A malformed mirror is unknown, never permission to type into a dialog. */
export function asVtSnapshot(value: unknown): VtSnapshot | null {
  return vtSnapshotValidationError(value) === null ? value as VtSnapshot : null;
}
