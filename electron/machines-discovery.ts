// Endpoint discovery is unauthenticated and bounded to one selected machine. No registry/auth writes.
import { isIP } from "node:net";
import { probeApi } from "./machines-api";
import type { Reach } from "./machines-probe";
import { requireSshTarget, runProcess, SSH_OPTIONS } from "./ssh";

export const API_DISCOVERY_PORTS = [8080, 8000, 1234, 5000] as const;
export interface ApiCandidate { baseUrl: string; kind: "confirmed" | "auth-required" }
export interface ApiDiscovery { candidates: ApiCandidate[]; error: string | null }

/** Only a host, never a URL/userinfo/path/options. IPv6 literals are bracketed when constructing URLs. */
export function discoveryHostname(value: string): string | null {
  if (isIP(value)) return value;
  if (value.startsWith("[") && value.endsWith("]") && isIP(value.slice(1, -1)) === 6) return value.slice(1, -1);
  if (value.length > 253 || !value || /^[\d.]+$/.test(value)) return null;
  return value.replace(/\.$/, "").split(".").every((label) => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ? value : null;
}

/** OpenSSH resolves Host/Include rules locally (-G exits without connecting). Do not execute Match exec,
 *  proxy commands, forwards or canonicalization; configs that depend on those need a manually entered URL. */
export async function resolveDiscoveryHost(target: string, run = runProcess): Promise<string | null> {
  if (process.platform === "win32") return null;
  const safeTarget = requireSshTarget(target);
  const options = [...SSH_OPTIONS, "ProxyCommand=none", "ProxyJump=none", "CanonicalizeHostname=no", "KnownHostsCommand=none", "LogLevel=QUIET"];
  const result = await run("ssh", [...options.flatMap((o) => ["-o", o]), "-G", "--", safeTarget], {
    deadlineMs: 1_500, maxOutputBytes: 20_000, env: { ...process.env, SHELL: "/usr/bin/false" },
  });
  if (result.code !== 0 || result.timedOut || result.spawnError || result.stdout.length >= 20_000) return null;
  const names = [...result.stdout.matchAll(/^hostname[\t ]+(\S+)[\t ]*$/gm)];
  return names.length === 1 ? discoveryHostname(names[0][1]) : null;
}

export async function discoverApiEndpoints(reach: Reach, deps: {
  resolveHost?: typeof resolveDiscoveryHost;
  probe?: typeof probeApi;
} = {}): Promise<ApiDiscovery> {
  try {
    const host = reach === "local" ? "127.0.0.1" : await (deps.resolveHost ?? resolveDiscoveryHost)(reach.ssh);
    const validated = host && discoveryHostname(host);
    if (!validated) return { candidates: [], error: "Could not resolve this SSH host. Enter the API URL manually." };
    const authority = isIP(validated) === 6 ? `[${validated}]` : validated;
    const candidates = await Promise.all(API_DISCOVERY_PORTS.map(async (port): Promise<ApiCandidate | null> => {
      const baseUrl = new URL(`http://${authority}:${port}/v1`).href;
      // Deliberately no access to machines-auth, even when the machine already has a saved token.
      const state = await (deps.probe ?? probeApi)(baseUrl, null, { timeoutMs: 1_500, maxBytes: 256_000 });
      if (state.up) return { baseUrl, kind: "confirmed" };
      if (state.error === "API authentication failed") return { baseUrl, kind: "auth-required" };
      return null;
    }));
    return { candidates: candidates.filter((c): c is ApiCandidate => c !== null), error: null };
  } catch { return { candidates: [], error: "Endpoint discovery failed. Enter the API URL manually or retry." }; }
}
