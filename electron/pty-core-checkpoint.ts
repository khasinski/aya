// Closed core envelope. It contains no owner credential or prepared env.
import type { OwnerPtyCheckpoint } from "./pty-owner-adapter";
import type { SpawnRequest } from "./types";
import type { PaneLaunch } from "./launch-mode";
import type { VtCheckpoint } from "./vt-checkpoint";
import { VtCheckpointTerminal } from "./vt-checkpoint";
import { parseCheckpointJson, validateCheckpointJson } from "./vt-checkpoint-schema";
import { checkpointMetadata } from "./vt-mirror";
import { StringDecoder } from "node:string_decoder";

export interface PaneCoreCheckpoint {
  format: 1;
  id: string;
  adapter: OwnerPtyCheckpoint;
  request: SpawnRequest;
  launch: PaneLaunch;
  spawnedAt: number;
  output: {chunks: string[]; total: number; version: number; end: number};
  oscCarry: string;
  vt: VtCheckpoint;
}
type Dict = Record<string, unknown>;
const fail = (): never => { throw new Error("Invalid PTY core checkpoint"); };
function object(v: unknown, required: string[], optional: string[] = []): Dict {
  if (!v || typeof v !== "object" || Array.isArray(v)) fail();
  const d = v as Dict;
  if (required.some(key => !Object.hasOwn(d, key)) || Object.keys(d).some(key => !required.includes(key) && !optional.includes(key))) fail();
  return d;
}
const int = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const str = (v: unknown, max = 65536): v is string => typeof v === "string" && v.length <= max && !v.includes("\0");
const strings = (v: unknown): boolean => Array.isArray(v) && v.length <= 128 && v.every(s => str(s));

/** Validate every opaque field before importing a terminal or attaching a master.
 * The trial VT is disposed; callers can preflight using the successor runtime. */
export async function validatePaneCoreCheckpoint(value: unknown): Promise<PaneCoreCheckpoint> {
  validateCheckpointJson(value);
  const d = object(value, ["format", "id", "adapter", "request", "launch", "spawnedAt", "output", "oscCarry", "vt"]);
  if (d.format !== 1 || !str(d.id, 128) || !d.id.length || !int(d.spawnedAt) || !str(d.oscCarry, 4096)) fail();
  const a = object(d.adapter, ["pane", "process", "readBytes", "decoderCarry"]);
  const p = object(a.pane, ["id", "generation", "pid", "cols", "rows", "exited", "exitCode", "signal", "event", "acknowledged", "startIdentity"], ["recoveryMembers"]);
  if (p.id !== d.id || !int(p.generation, 1, 0xffffffff) || !int(p.pid, 2, 0x7fffffff) || !int(p.cols, 2, 1000) || !int(p.rows, 1, 1000) ||
      typeof p.exited !== "boolean" || !(p.exitCode === null || int(p.exitCode, 0, 255)) || !int(p.signal, 0, 128) || !int(p.event, 0, 0xffffffff) ||
      typeof p.acknowledged !== "boolean" || !str(p.startIdentity, 63) || !/^\d+:\d+$/.test(p.startIdentity) || !str(a.process) || !int(a.readBytes) || !str(a.decoderCarry, 4)) fail();
  const carry = Buffer.from(a.decoderCarry as string, "base64");
  if (carry.length > 3 || carry.toString("base64") !== a.decoderCarry || (a.readBytes as number) < carry.length || new StringDecoder("utf8").write(carry) !== "") fail();
  if (p.recoveryMembers !== undefined && (!Array.isArray(p.recoveryMembers) || p.recoveryMembers.length > 32 || !p.recoveryMembers.every(member => {
    const m = object(member, ["pid", "startIdentity"]); return int(m.pid, 2, 0x7fffffff) && (m.startIdentity === null || (str(m.startIdentity, 63) && /^\d+:\d+$/.test(m.startIdentity)));
  }))) fail();
  const r = object(d.request, ["ptyId", "command", "cwd", "cols", "rows"], ["projectSlug", "presetId", "agent", "agentConfigDir", "sharedDirCommand", "peerCwds", "attachOnly", "attachIfReused", "teamLaunch"]);
  if (r.ptyId !== d.id || !str(r.command) || !str(r.cwd) || !int(r.cols, 2, 1000) || !int(r.rows, 1, 1000)) fail();
  for (const key of ["projectSlug", "presetId", "agentConfigDir", "sharedDirCommand"]) if (r[key] !== undefined && !str(r[key])) fail();
  for (const key of ["attachOnly", "attachIfReused", "teamLaunch"]) if (r[key] !== undefined && typeof r[key] !== "boolean") fail();
  if (r.peerCwds !== undefined && !strings(r.peerCwds)) fail();
  const v = object(d.vt, ["base", "tail", "metadata"]), metadata = checkpointMetadata(v.metadata);
  if (r.agent !== undefined && r.agent !== metadata.agent) fail();
  const l = object(d.launch, ["command", "cwd"], ["added", "mode"]);
  if (!str(l.command) || !str(l.cwd) || (l.added !== undefined && !strings(l.added))) fail();
  if (l.mode !== undefined) {
    const m = object(l.mode, ["cli", "mode", "reach", "why", "fix", "autoFix"], ["todo", "note"]);
    if (!str(m.cli) || !str(m.mode) || !["reaches", "blocked", "unknown"].includes(m.reach as string) || !(m.why === null || str(m.why)) || !strings(m.fix) || typeof m.autoFix !== "boolean" ||
        (m.todo !== undefined && !str(m.todo)) || (m.note !== undefined && !str(m.note))) fail();
  }
  const o = object(d.output, ["chunks", "total", "version", "end"]);
  if (!Array.isArray(o.chunks) || o.chunks.length > 1_000_000 || !o.chunks.every(s => typeof s === "string") || !int(o.total, 0, 1_000_000) || !int(o.version) || !int(o.end, o.total as number) ||
      o.chunks.reduce((n: number, s: string) => n + s.length, 0) !== o.total) fail();
  // A resize may live in the raw tail; compare the applied geometry, not only
  // the older ground base, after bounded schema validation/replay.
  const trial = await VtCheckpointTerminal.import(d.vt as VtCheckpoint);
  try { if (trial.terminal.cols !== p.cols || trial.terminal.rows !== p.rows) fail(); }
  finally { trial.dispose(); }
  return value as PaneCoreCheckpoint;
}
export async function parsePaneCoreCheckpoint(bytes: Buffer): Promise<PaneCoreCheckpoint> {
  return validatePaneCoreCheckpoint(parseCheckpointJson(bytes));
}

/** A retained, unacknowledged exit has no live master to attach. */
export interface EndedCoreCheckpoint {
 format:1;kind:"ended";id:string;generation:string;exitCode:number;
 output:PaneCoreCheckpoint["output"];
}
export type CoreHandoverPart=PaneCoreCheckpoint|EndedCoreCheckpoint;
export function checkpointGeneration(pane:CoreHandoverPart):string {
 return "kind" in pane?pane.generation:(pane.vt.metadata as {generation:string}).generation;
}
export async function validateCoreHandoverPart(value:unknown):Promise<CoreHandoverPart>{
 if(!value||typeof value!=="object"||!("kind" in value))return validatePaneCoreCheckpoint(value);
 validateCheckpointJson(value);
 const d=object(value,["format","kind","id","generation","exitCode","output"]);
 if(d.format!==1||d.kind!=="ended"||!str(d.id,128)||!d.id.length||!str(d.generation,128)||!d.generation.length||!int(d.exitCode,0,255))fail();
 const o=object(d.output,["chunks","total","version","end"]);
 if(!Array.isArray(o.chunks)||o.chunks.length>1_000_000||!o.chunks.every(s=>typeof s==="string")||!int(o.total,0,1_000_000)||!int(o.version)||!int(o.end,o.total as number)||o.chunks.reduce((n:number,s:string)=>n+s.length,0)!==o.total)fail();
 return value as EndedCoreCheckpoint;
}
