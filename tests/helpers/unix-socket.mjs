import * as net from "node:net";

/** Connects once the server accepts. listen() creates the socket file at bind, a moment before it
 *  accepts, so a connect in that moment is refused (seen on macOS CI): retry that, and a missing
 *  file, until ms elapses. */
export async function connectWhenListening(path, ms = 10_000, step = 25) {
  const deadline = Date.now() + ms;
  for (;;) {
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(path);
        socket.once("error", reject);
        socket.once("connect", () => {
          socket.off("error", reject);
          resolve(socket);
        });
      });
    } catch (error) {
      if ((error.code !== "ECONNREFUSED" && error.code !== "ENOENT") || Date.now() >= deadline) throw error;
    }
    await new Promise((r) => setTimeout(r, step));
  }
}
