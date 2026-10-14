import * as fs from "node:fs";
import type * as net from "node:net";
import { SOCKET_FILE_PERMISSIONS } from "./pty-host-paths";

// Group and others get nothing on a file made while this umask is set.
const OWNER_ONLY_UMASK = 0o077;

/** Listens on a Unix socket that is owner-only from the moment it exists. listen() binds, and so
 *  creates the file, before it returns (measured on Node and Electron 43): with the default umask
 *  the file was 0755 until the chmod in the listening callback, so another user could connect
 *  first. The tighter umask covers the bind; the chmod then sets the documented 0600. The umask is
 *  process-wide: a file another task creates in that instant is owner-only too, never wider. */
export function listenOwnerOnly(server: net.Server, socketPath: string, onListening?: () => void): void {
  const umask = process.umask(OWNER_ONLY_UMASK);
  try {
    server.listen(socketPath, () => {
      try {
        fs.chmodSync(socketPath, SOCKET_FILE_PERMISSIONS);
      } catch {
        // best effort
      }
      onListening?.();
    });
  } finally {
    process.umask(umask);
  }
}
