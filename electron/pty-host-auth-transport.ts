import type {Socket} from "node:net";
import {randomBytes} from "node:crypto";
import {HostAuthClient, HostAuthServer, HostAuthError, HostPrincipalBusyError, HOST_AUTH_FRAME_BYTES, HOST_AUTH_TIMEOUT_MS, type HostAuthPeer} from "./pty-host-auth";
import {handoverPeer} from "./pty-handover-window";
import {HostAuthTransfer} from "./pty-host-auth-transfer";
import {HostRedemptionServer} from "./pty-host-auth-redemption";

export const HOST_AUTH_PENDING_CONNECTIONS = 32;
export interface AuthenticatedHostSocket {peer: HostAuthPeer; buffered: string}
export type AcceptedHostSocket=AuthenticatedHostSocket|{transferred:true};
type PeerReader = (socket: Socket) => HostAuthPeer;
interface Session {
  authenticated: boolean;
  receive(line: string): string | null;
  principalBusy?(): string;
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
  authorize?: (peer: HostAuthPeer) => void,initialBuffer="",deadline=performance.now()+HOST_AUTH_TIMEOUT_MS): Promise<AuthenticatedHostSocket> {
  return new Promise((resolve, reject) => {
    let buffer = "", settled = false;
    const timer = setTimeout(() => failed(), Math.max(0,deadline-performance.now()));
    const cleanup = () => {
      clearTimeout(timer);socket.off("data", data);socket.off("error", failed);socket.off("close", failed);
    };
    const failed = (error?:unknown) => {
      if (settled) return;
      settled = true;cleanup();
      const busy=error instanceof HostPrincipalBusyError;
      // Busy is revealed only after the client proof, and its response has a
      // separate MAC bound to this exact transcript. Invalid proof stays opaque.
      if(server&&busy&&session.authenticated&&session.principalBusy){
        socket.end(session.principalBusy()+"\n",()=>socket.destroy());
        const closing=setTimeout(()=>socket.destroy(),100);closing.unref();
      }else if (server) refuse(socket); else socket.destroy();
      reject(busy?error:new HostAuthError());
    };
    const data = (chunk: string | Buffer) => {
      if (settled) return;
      buffer += String(chunk);
      try {
        if(performance.now()>=deadline)throw new HostAuthError();
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
      } catch(error) {failed(error);}
    };
    socket.setEncoding("utf8");socket.on("data", data);socket.on("error", failed);socket.on("close", failed);
    if (socket.destroyed || !socket.writable) failed(); else {if(initialBuffer)data(initialBuffer);if(!settled)socket.resume();}
  });
}

/** Classify one bounded opening frame, then keep the original accept deadline
 * for either protocol. No application bytes are dispatched by this reader. */
function openingFrame(socket:Socket,deadline:number):Promise<{line:string;buffered:string}>{
 return new Promise((resolve,reject)=>{
  let buffer="",settled=false;
  const cleanup=()=>{clearTimeout(timer);socket.off("data",data);socket.off("error",fail);socket.off("close",fail);};
  const fail=()=>{if(settled)return;settled=true;cleanup();socket.pause();reject(new HostAuthError());};
  const timer=setTimeout(fail,Math.max(0,deadline-performance.now()));
  const data=(chunk:string|Buffer)=>{
   if(settled)return;buffer+=String(chunk);
   const end=buffer.indexOf("\n");
   if(performance.now()>=deadline||(end<0?Buffer.byteLength(buffer)>HOST_AUTH_FRAME_BYTES:Buffer.byteLength(buffer.slice(0,end))>HOST_AUTH_FRAME_BYTES)){fail();return;}
   if(end<0)return;
   settled=true;cleanup();socket.pause();resolve({line:buffer.slice(0,end),buffered:buffer.slice(end+1)});
  };
  socket.setEncoding("utf8");socket.on("data",data);socket.on("error",fail);socket.on("close",fail);
  if(socket.destroyed||!socket.writable)fail();else socket.resume();
 });
}

/** The host provides a conservative kernel observation. Only proven `gone`
 * releases a different principal; unknown is never equivalent to gone. */
export class HostAuthPrincipal {
  private current: HostAuthPeer | null = null;
  constructor(private readonly observe: (peer: HostAuthPeer) => "same" | "gone" | "unknown") {}
  authorize(peer: HostAuthPeer): void {
    const prior = this.current;
    if (prior && (prior.pid !== peer.pid || prior.startIdentity !== peer.startIdentity) && this.observe(prior) !== "gone") throw new HostPrincipalBusyError();
    this.current = {...peer};
  }
}

export class HostSocketAuthenticator {
  private readonly pending = new Set<Socket>();
  private readonly instance = randomBytes(32).toString("hex");
  private readonly key: Buffer;
  constructor(key: Buffer, private readonly ownPeer: HostAuthPeer,
    private readonly authorize: (peer: HostAuthPeer) => void, private readonly readPeer: PeerReader = handoverPeer,
    private readonly transfer?:HostAuthTransfer) {this.key=Buffer.from(key);}
  get pendingConnections(): number {return this.pending.size;}
  async accept(socket: Socket): Promise<AcceptedHostSocket> {
    const deadline=performance.now()+HOST_AUTH_TIMEOUT_MS;
    // Also retain failed sockets until their bounded refusal/close completes.
    if (this.pending.size >= HOST_AUTH_PENDING_CONNECTIONS) {socket.destroy();throw new HostAuthError();}
    this.pending.add(socket);socket.once("close", () => this.pending.delete(socket));
    // A rejected peer probe still needs an error handler during close.
    socket.on("error", () => {});
    try {
      const peer = this.readPeer(socket);
      const first=await openingFrame(socket,deadline),request=JSON.parse(first.line) as {type?:unknown}|null;
      if(this.transfer&&request?.type==="pty-transfer-redeem"){
        if(first.buffered||performance.now()>=deadline)throw new HostAuthError();
        const response=new HostRedemptionServer(this.transfer,this.ownPeer,peer,()=>performance.now(),this.instance).receive(first.line);
        if(performance.now()>=deadline)throw new HostAuthError();
        socket.end(response+"\n",()=>socket.destroy());
        const closing=setTimeout(()=>socket.destroy(),1000);closing.unref();socket.once("close",()=>clearTimeout(closing));
        return {transferred:true}; // stays in the pending budget until close
      }
      const result = await handshake(socket, new HostAuthServer(this.key, this.ownPeer, peer, this.instance), peer, true, this.authorize,first.line+"\n"+first.buffered,deadline);
      this.pending.delete(socket);return result;
    } catch(error) {refuse(socket);if(error instanceof HostPrincipalBusyError)throw error;throw new HostAuthError();}
  }
}
export async function authenticateHostSocket(socket: Socket, key: Buffer, ownPeer: HostAuthPeer,
  readPeer: PeerReader = handoverPeer): Promise<AuthenticatedHostSocket> {
  try {
    const peer = readPeer(socket), session = new HostAuthClient(key, peer, ownPeer);
    const ready = handshake(socket, session, peer, false);
    socket.write(session.hello + "\n");
    return await ready;
  } catch(error) {socket.destroy();if(error instanceof HostPrincipalBusyError)throw error;throw new HostAuthError();}
}
