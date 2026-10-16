import type {Socket} from "node:net";
import {randomBytes} from "node:crypto";
import {HostAuthClient, HostAuthServer, HostAuthError, HOST_AUTH_FRAME_BYTES, HOST_AUTH_TIMEOUT_MS, type HostAuthPeer} from "./pty-host-auth";
import {handoverPeer} from "./pty-handover-window";

export const HOST_AUTH_PENDING_CONNECTIONS = 32;
export interface AuthenticatedHostSocket {peer: HostAuthPeer; buffered: string}
type PeerReader = (socket: Socket) => HostAuthPeer;
interface Session {
  authenticated: boolean;
  receive(line: string): string | null;
}
const AUTH_REQUIRED = JSON.stringify({id: -1, ok: false, code: "PTY_HOST_AUTH_REQUIRED", error: "Terminal host authentication required"}) + "\n";
function refuse(socket: Socket): void {
  if (socket.destroyed || socket.writableEnded) return;
  socket.end(AUTH_REQUIRED, () => socket.destroy());
  const timer = setTimeout(() => socket.destroy(), 100); timer.unref();
}
/** Success leaves the stream paused. The caller installs its normal parser,
 * applies buffered bytes, then resumes; there is no unobserved data interval. */
function handshake(socket: Socket, session: Session, peer: HostAuthPeer, server: boolean,
  authorize?: (peer: HostAuthPeer) => void): Promise<AuthenticatedHostSocket> {
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const timer = setTimeout(() => failed(), HOST_AUTH_TIMEOUT_MS);
    const cleanup = () => {
      clearTimeout(timer);socket.off("data", data);socket.off("error", failed);socket.off("close", failed);
    };
    const failed = () => {
      if (settled) return;
      settled = true;cleanup();
      // No error object from a parser, peer probe or socket reaches logs/UI.
      if (server) refuse(socket); else socket.destroy();
      reject(new HostAuthError());
    };
    const data = (chunk: string | Buffer) => {
      if (settled) return;
      buffer += String(chunk);
      try {
        for (;;) {
          const end = buffer.indexOf("\n");
          if (end < 0) {if (Buffer.byteLength(buffer) > HOST_AUTH_FRAME_BYTES) failed();return;}
          const line = buffer.slice(0, end);buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > HOST_AUTH_FRAME_BYTES) throw new HostAuthError();
          const response = session.receive(line);
          if (session.authenticated) {
            // A valid proof does not displace another live/unknown principal.
            authorize?.(peer);
            socket.pause();settled = true;cleanup();
            if (response !== null) socket.write(response + "\n");
            resolve({peer: {...peer}, buffered: buffer});return;
          }
          if (response !== null) socket.write(response + "\n");
        }
      } catch {failed();}
    };
    socket.setEncoding("utf8");socket.on("data", data);socket.on("error", failed);socket.on("close", failed);
    if (socket.destroyed || !socket.writable) failed(); else socket.resume();
  });
}

/** The host provides a conservative kernel observation. Only proven `gone`
 * releases a different principal; unknown is never equivalent to gone. */
export class HostAuthPrincipal {
  private current: HostAuthPeer | null = null;
  constructor(private readonly observe: (peer: HostAuthPeer) => "same" | "gone" | "unknown") {}
  authorize(peer: HostAuthPeer): void {
    const prior = this.current;
    if (prior && (prior.pid !== peer.pid || prior.startIdentity !== peer.startIdentity) && this.observe(prior) !== "gone") throw new HostAuthError();
    this.current = {...peer};
  }
}

export class HostSocketAuthenticator {
  private readonly pending = new Set<Socket>();
  private readonly instance = randomBytes(32).toString("hex");
  private readonly key: Buffer;
  constructor(key: Buffer, private readonly ownPeer: HostAuthPeer,
    private readonly authorize: (peer: HostAuthPeer) => void, private readonly readPeer: PeerReader = handoverPeer) {this.key=Buffer.from(key);}
  get pendingConnections(): number {return this.pending.size;}
  async accept(socket: Socket): Promise<AuthenticatedHostSocket> {
    // Also retain failed sockets until their bounded refusal/close completes.
    if (this.pending.size >= HOST_AUTH_PENDING_CONNECTIONS) {socket.destroy();throw new HostAuthError();}
    this.pending.add(socket);socket.once("close", () => this.pending.delete(socket));
    // A rejected peer probe still needs an error handler during close.
    socket.on("error", () => {});
    try {
      const peer = this.readPeer(socket);
      const result = await handshake(socket, new HostAuthServer(this.key, this.ownPeer, peer, this.instance), peer, true, this.authorize);
      this.pending.delete(socket);return result;
    } catch {refuse(socket);throw new HostAuthError();}
  }
}
export async function authenticateHostSocket(socket: Socket, key: Buffer, ownPeer: HostAuthPeer,
  readPeer: PeerReader = handoverPeer): Promise<AuthenticatedHostSocket> {
  try {
    const peer = readPeer(socket), session = new HostAuthClient(key, peer, ownPeer);
    const ready = handshake(socket, session, peer, false);
    socket.write(session.hello + "\n");
    return await ready;
  } catch {socket.destroy();throw new HostAuthError();}
}
