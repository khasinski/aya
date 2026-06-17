import type { Preset, ProjectCollectionState, ProjectConfig } from "./types";

export const REMOTE_PROTOCOL_VERSION = 1;

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
      code: string;
      message: string;
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

export function remoteError(code: string, message: string): RemoteMessage {
  return {
    type: "error",
    protocol: REMOTE_PROTOCOL_VERSION,
    code,
    message,
  };
}
