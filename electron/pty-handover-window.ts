import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { ownerArtifactPaths } from "./pty-owner-client";

export interface HandoverPeer { pid: number; startIdentity: string }
export const HANDOVER_WINDOW_MS = 120_000;
const nonceOk = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function peerOk(peer: HandoverPeer): boolean {
  return !!peer && Number.isSafeInteger(peer.pid) && peer.pid > 1 && typeof peer.startIdentity === "string" && /^\d+:\d+$/.test(peer.startIdentity) && peer.startIdentity.length <= 63;
}
export function handoverPeer(socket: Socket): HandoverPeer {
  const fd = (socket as Socket & {_handle?: {fd?: number}})._handle?.fd;
  if (typeof fd !== "number" || fd < 3 || socket.destroyed) throw new Error("Handover peer is unavailable");
  const bridge = require(ownerArtifactPaths().bridge) as {peerIdentity(fd: number): HandoverPeer};
  const peer = bridge.peerIdentity(fd);
  if (!peerOk(peer)) throw new Error("Handover peer identity is unavailable");
  return peer;
}

/** Same-account trust, not executable authentication. A planned old-main
 * announcement opens one short-lived attempt; even a wrong attempt closes it.
 * No owner credential, nonce or candidate is included in errors/log messages. */
export class HandoverWindow {
  private announcement: {nonce: Buffer; deadline: number; announcer: HandoverPeer} | null = null;
  private recipient: HandoverPeer | null = null;
  private consumed = false;
  constructor(private readonly clock: () => number = Date.now) {}
  announce(nonce: string, deadline: number, peer: HandoverPeer): void {
    const now = this.clock();
    if (this.announcement && now >= this.announcement.deadline) this.announcement = null;
    if (this.consumed || this.announcement || !nonceOk(nonce) || !peerOk(peer) || !Number.isSafeInteger(deadline) || deadline <= now || deadline - now > HANDOVER_WINDOW_MS) throw new Error("Handover announcement refused");
    this.announcement = {nonce: Buffer.from(nonce, "hex"), deadline, announcer: {...peer}};
  }
  consume(nonce: string, peer: HandoverPeer): HandoverPeer {
    const announcement = this.announcement;
    this.announcement = null;
    // A wrong request closes this announced window permanently too.
    if (announcement) this.consumed = true;
    if (!announcement || this.clock() >= announcement.deadline || !nonceOk(nonce) || !peerOk(peer) ||
        !timingSafeEqual(announcement.nonce, Buffer.from(nonce, "hex"))) throw new Error("Handover credential transfer refused");
    this.recipient = {...peer};
    return {...this.recipient};
  }
  cancel(peer: HandoverPeer): void {
    if (this.announcement && this.announcement.announcer.pid === peer.pid && this.announcement.announcer.startIdentity === peer.startIdentity) this.announcement = null;
  }
  get transferredTo(): HandoverPeer | null { return this.recipient && {...this.recipient}; }
}
