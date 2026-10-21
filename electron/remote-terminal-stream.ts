import type * as net from "node:net";

export const REMOTE_TERMINAL_SOCKET_QUEUE_MAX_BYTES = 2 * 1024 * 1024;
// A frame of escaped JSON is at most about six times the raw UTF-8 payload.
// This leaves room under the 2 MiB queue limit even for control-heavy output.
export const REMOTE_TERMINAL_FRAME_DATA_MAX_BYTES = 256 * 1024;

/** All v2 writes share this queue bound, including command replies and replay. */
export function writeRemoteTerminalFrame(socket: net.Socket, message: unknown): boolean {
  if (socket.destroyed) return false;
  const frame = `${JSON.stringify(message)}\n`;
  if (socket.writableLength + Buffer.byteLength(frame, "utf8") > REMOTE_TERMINAL_SOCKET_QUEUE_MAX_BYTES) {
    socket.destroy();
    return false;
  }
  socket.write(frame);
  return true;
}
