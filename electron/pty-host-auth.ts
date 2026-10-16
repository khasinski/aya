// Pure bounded handshake; socket dispatch remains closed until both proofs
// complete. Neither this module nor the host reads a persistent capability.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const HOST_AUTH_PROTOCOL = 1;
export const HOST_AUTH_FRAME_BYTES = 1024;
export const HOST_AUTH_TIMEOUT_MS = 5000;
export interface HostAuthPeer {pid: number; startIdentity: string}
const hex = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const peer = (value: unknown): value is HostAuthPeer => {
  if (!value || typeof value !== "object") return false;
  const v = value as HostAuthPeer;
  return Object.keys(v).sort().join(",") === "pid,startIdentity" && Number.isSafeInteger(v.pid) && v.pid > 1 &&
    typeof v.startIdentity === "string" && /^\d+:\d+$/.test(v.startIdentity) && v.startIdentity.length <= 63;
};
export class HostAuthError extends Error {
  readonly code = "PTY_HOST_AUTH_REQUIRED";
  constructor() { super("Terminal host authentication required"); }
}
function frame(line: string, keys: string[]): Record<string, unknown> {
  if (Buffer.byteLength(line) > HOST_AUTH_FRAME_BYTES) throw new HostAuthError();
  const value: unknown = JSON.parse(line);
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== keys.sort().join(",")) throw new HostAuthError();
  return value as Record<string, unknown>;
}
interface Transcript {clientNonce: string; serverNonce: string; instance: string; host: HostAuthPeer; client: HostAuthPeer}
function proof(key: Buffer, role: string, t: Transcript): string {
  return createHmac("sha256", key).update(JSON.stringify(["aya-pty-host-auth", HOST_AUTH_PROTOCOL, role, t.clientNonce, t.serverNonce,
    t.instance, t.host.pid, t.host.startIdentity, t.client.pid, t.client.startIdentity])).digest("hex");
}
const matches = (expected: string, actual: unknown): boolean => hex(actual) && timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
class Session {
  protected readonly key: Buffer;
  protected readonly deadline: number;
  protected phase = 0;
  constructor(key: Buffer, protected readonly host: HostAuthPeer, protected readonly client: HostAuthPeer,
    protected readonly clock: () => number) {
    if (key.length !== 32 || !peer(host) || !peer(client)) throw new HostAuthError();
    this.key = Buffer.from(key); this.deadline = clock() + HOST_AUTH_TIMEOUT_MS;
  }
  get authenticated(): boolean { return this.phase === 2; }
  protected check(expected: number): void {
    if (this.phase !== expected || this.clock() >= this.deadline) { this.phase = -1; throw new HostAuthError(); }
  }
}
export class HostAuthServer extends Session {
  private transcript?: Transcript;
  constructor(key: Buffer, host: HostAuthPeer, client: HostAuthPeer, private readonly instance: string,
    clock: () => number = () => performance.now()) {
    super(key, host, client, clock);
    if (!hex(instance)) throw new HostAuthError();
  }
  receive(line: string): string {
    try {
      if (this.phase === 0) {
        this.check(0);
        const hello = frame(line, ["type", "version", "nonce"]);
        if (hello.type !== "pty-auth-hello" || hello.version !== HOST_AUTH_PROTOCOL || !hex(hello.nonce)) throw new HostAuthError();
        const t = this.transcript = {clientNonce: hello.nonce, serverNonce: randomBytes(32).toString("hex"), instance: this.instance, host: {...this.host}, client: {...this.client}};
        this.phase = 1;
        return JSON.stringify({type: "pty-auth-challenge", version: HOST_AUTH_PROTOCOL, nonce: t.serverNonce, instance: t.instance, proof: proof(this.key, "server", t)});
      }
      this.check(1);
      const response = frame(line, ["type", "proof"]), t = this.transcript!;
      if (response.type !== "pty-auth-proof" || !matches(proof(this.key, "client", t), response.proof)) throw new HostAuthError();
      this.phase = 2;
      return JSON.stringify({type: "pty-auth-ready", proof: proof(this.key, "ready", t)});
    } catch { this.phase = -1; throw new HostAuthError(); }
  }
}
export class HostAuthClient extends Session {
  readonly hello: string;
  private readonly nonce = randomBytes(32).toString("hex");
  private transcript?: Transcript;
  constructor(key: Buffer, host: HostAuthPeer, client: HostAuthPeer, clock: () => number = () => performance.now()) {
    super(key, host, client, clock);
    this.hello = JSON.stringify({type: "pty-auth-hello", version: HOST_AUTH_PROTOCOL, nonce: this.nonce});
  }
  receive(line: string): string | null {
    try {
      if (this.phase === 0) {
        this.check(0);
        const challenge = frame(line, ["type", "version", "nonce", "instance", "proof"]);
        if (challenge.type !== "pty-auth-challenge" || challenge.version !== HOST_AUTH_PROTOCOL || !hex(challenge.nonce) || !hex(challenge.instance)) throw new HostAuthError();
        const t = {clientNonce: this.nonce, serverNonce: challenge.nonce, instance: challenge.instance, host: {...this.host}, client: {...this.client}};
        if (!matches(proof(this.key, "server", t), challenge.proof)) throw new HostAuthError();
        this.transcript = t; this.phase = 1;
        return JSON.stringify({type: "pty-auth-proof", proof: proof(this.key, "client", t)});
      }
      this.check(1);
      const ready = frame(line, ["type", "proof"]);
      if (ready.type !== "pty-auth-ready" || !matches(proof(this.key, "ready", this.transcript!), ready.proof)) throw new HostAuthError();
      this.phase = 2; return null;
    } catch { this.phase = -1; throw new HostAuthError(); }
  }
}
