import * as path from "node:path";
import { CONTROL_SOCKET_NAME, PTY_HOST_SOCKET_NAME, REMOTE_SOCKET_NAME } from "./constants";

// Measured with net.listen and connect: macOS binds 104 bytes and refuses 105 (sun_path
// is 104 with its NUL); Linux's sun_path is 108. bin/aya repeats both.
export const DARWIN_SOCKET_PATH_MAX_BYTES = 104;
export const LINUX_SOCKET_PATH_MAX_BYTES = 107;

export function socketPathLimit(platform: NodeJS.Platform = process.platform): number {
  return platform === "darwin" ? DARWIN_SOCKET_PATH_MAX_BYTES : LINUX_SOCKET_PATH_MAX_BYTES;
}

/** What `home` cannot hold: `fatal` stops Aya, `remote` only turns the remote bridge off. */
export function homeSocketProblems(
  home: string,
  platform: NodeJS.Platform = process.platform,
): { fatal: string | null; remote: string | null } {
  const limit = socketPathLimit(platform);
  const over = (name: string) => {
    const length = Buffer.byteLength(path.join(home, name));
    return length > limit ? length : 0;
  };
  const fatalLength = Math.max(over(CONTROL_SOCKET_NAME), over(PTY_HOST_SOCKET_NAME));
  const remoteLength = over(REMOTE_SOCKET_NAME);
  return {
    fatal: fatalLength
      ? `AYA_HOME is too long for Aya's sockets: ${home} makes a ${fatalLength}-byte socket path, the limit is ${limit}. Set AYA_HOME to a shorter directory.`
      : null,
    remote: remoteLength
      ? `the remote bridge is off: AYA_HOME is too long for its socket (${remoteLength} bytes, the limit is ${limit}). Set AYA_HOME to a shorter directory.`
      : null,
  };
}
