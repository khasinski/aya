import type { Preset, ProjectCollectionState, ProjectConfig } from "./types";

export const REMOTE_PROTOCOL_VERSION = 1;
export const REMOTE_MAX_FRAME_BYTES = 2 * 1024 * 1024;
/** The v1 hello/snapshot and one-shot directory/project verbs remain the
 * compatibility handshake. A client opts into this version on the same
 * connection before using the long-lived terminal stream. */
export const REMOTE_TERMINAL_PROTOCOL_VERSION = 2;
export const REMOTE_TERMINAL_REPLAY_MAX_BYTES = 1_048_576;

export interface RemoteHostInfo {
  id: string;
  name: string;
  platform: NodeJS.Platform;
  user: string;
}

export interface RemoteSnapshot {
  projects: ProjectConfig[];
  projectState: ProjectCollectionState;
  presets: Preset[];
}

export interface RemoteDirectoryEntry {
  name: string;
  path: string;
  kind: "directory";
}

export type RemoteTerminalRequest =
  | { type: "session:open"; protocol: number; id: string }
  | { type: "pty:spawn"; protocol: 2; id: string; project: string; preset: string; cols: number; rows: number }
  | { type: "pty:attach"; protocol: 2; id: string; terminalId: string; offset: number }
  | { type: "pty:write"; protocol: 2; id: string; terminalId: string; data: string }
  | { type: "pty:resize"; protocol: 2; id: string; terminalId: string; cols: number; rows: number }
  | { type: "pty:exit"; protocol: 2; id: string; terminalId: string }
  | { type: "pty:list"; protocol: 2; id: string };

export type RemoteTerminalMessage =
  | { type: "session:ready"; protocol: 2; id: string }
  | { type: "pty:spawned"; protocol: 2; id: string; terminalId: string; project: string; preset: string }
  | { type: "pty:attached"; protocol: 2; id: string; terminalId: string; fromOffset: number; endOffset: number; truncated: boolean }
  | { type: "pty:output"; protocol: 2; terminalId: string; offset: number; data: string }
  | { type: "pty:spawn-failed"; protocol: 2; terminalId: string; reason?: string; message: string }
  | { type: "pty:written"; protocol: 2; id: string; terminalId: string; accepted: boolean }
  | { type: "pty:resized"; protocol: 2; id: string; terminalId: string }
  | { type: "pty:exited"; protocol: 2; terminalId: string; exitCode: number; killed?: never }
  | { type: "pty:exited"; protocol: 2; terminalId: string; killed: true; exitCode?: never }
  | { type: "pty:list-result"; protocol: 2; id: string; terminals: Array<{ terminalId: string; project: string; preset: string; state: "running" | "exited" | "failed" | "uncertain"; offset: number; failureReason?: string }> }
  | { type: "pty:exit-result"; protocol: 2; id: string; terminalId: string };

function ownKeys(value: Record<string, unknown>, keys: string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** Strict frame validation. Unknown keys are refused so newer clients cannot
 * accidentally smuggle command/cwd fields into this host-side API. */
export function parseRemoteTerminalRequest(value: unknown): RemoteTerminalRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const str = (key: string, max = 256): boolean => typeof record[key] === "string" && (record[key] as string).length > 0 && (record[key] as string).length <= max;
  const dimension = (key: string): boolean => Number.isSafeInteger(record[key]) && (record[key] as number) >= 1 && (record[key] as number) <= 500;
  if (record.type === "session:open") {
    if (!ownKeys(record, ["type", "protocol", "id"]) || !str("id", 128) || !Number.isSafeInteger(record.protocol)) return null;
    return { type: "session:open", protocol: record.protocol as number, id: record.id as string };
  }
  if (record.protocol !== REMOTE_TERMINAL_PROTOCOL_VERSION || !str("id", 128)) return null;
  switch (record.type) {
    case "pty:spawn":
      return ownKeys(record, ["type", "protocol", "id", "project", "preset", "cols", "rows"]) && str("project") && str("preset") && dimension("cols") && dimension("rows")
        ? { type: "pty:spawn", protocol: 2, id: record.id as string, project: record.project as string, preset: record.preset as string, cols: record.cols as number, rows: record.rows as number } : null;
    case "pty:attach":
      return ownKeys(record, ["type", "protocol", "id", "terminalId", "offset"]) && str("terminalId") && Number.isSafeInteger(record.offset) && (record.offset as number) >= 0
        ? { type: "pty:attach", protocol: 2, id: record.id as string, terminalId: record.terminalId as string, offset: record.offset as number } : null;
    case "pty:write":
      return ownKeys(record, ["type", "protocol", "id", "terminalId", "data"]) && str("terminalId") && typeof record.data === "string" && Buffer.byteLength(record.data, "utf8") <= 256 * 1024
        ? { type: "pty:write", protocol: 2, id: record.id as string, terminalId: record.terminalId as string, data: record.data as string } : null;
    case "pty:resize":
      return ownKeys(record, ["type", "protocol", "id", "terminalId", "cols", "rows"]) && str("terminalId") && dimension("cols") && dimension("rows")
        ? { type: "pty:resize", protocol: 2, id: record.id as string, terminalId: record.terminalId as string, cols: record.cols as number, rows: record.rows as number } : null;
    case "pty:exit":
      return ownKeys(record, ["type", "protocol", "id", "terminalId"]) && str("terminalId")
        ? { type: "pty:exit", protocol: 2, id: record.id as string, terminalId: record.terminalId as string } : null;
    case "pty:list":
      return ownKeys(record, ["type", "protocol", "id"])
        ? { type: "pty:list", protocol: 2, id: record.id as string } : null;
    default:
      return null;
  }
}

export type RemoteMessage =
  | {
      type: "hello";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      host: RemoteHostInfo;
      app: { version: string };
      permissions: { mode: "read-only" };
    }
  | {
      type: "snapshot";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      generatedAt: number;
      snapshot: RemoteSnapshot;
    }
  | {
      type: "error";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      id?: string;
      code: string;
      message: string;
    }
  | {
      type: "fs:list-result";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      id: string;
      path: string;
      entries: RemoteDirectoryEntry[];
    }
  | {
      type: "fs:mkdir-result";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      id: string;
      path: string;
    }
  | {
      type: "project:create-result";
      protocol: typeof REMOTE_PROTOCOL_VERSION;
      id: string;
      project: ProjectConfig;
    };

export function remoteHello(
  host: RemoteHostInfo,
  appVersion: string,
): RemoteMessage {
  return {
    type: "hello",
    protocol: REMOTE_PROTOCOL_VERSION,
    host,
    app: { version: appVersion },
    permissions: { mode: "read-only" },
  };
}

export function remoteSnapshot(snapshot: RemoteSnapshot): RemoteMessage {
  return {
    type: "snapshot",
    protocol: REMOTE_PROTOCOL_VERSION,
    generatedAt: Date.now(),
    snapshot,
  };
}

export function remoteError(
  code: string,
  message: string,
  id?: string,
): RemoteMessage {
  return {
    type: "error",
    protocol: REMOTE_PROTOCOL_VERSION,
    ...(id ? { id } : {}),
    code,
    message,
  };
}
