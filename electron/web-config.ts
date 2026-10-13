// Aya Web (experimental) — persistence for the browser-access server config.
//
// Stored at ~/.aya/web.json with owner-only permissions. Passwords are kept
// as scrypt hashes; ONLY the auto-generated first-run password is also kept
// in plaintext (`generatedPassword`) so the Settings UI can display it. When
// the user sets a custom password the plaintext copy is cleared and never
// stored again.

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME, OWNER_ONLY_FILE_MODE } from "./paths";

export const WEB_CONFIG_FILE = path.join(AYA_HOME, "web.json");

// Unassigned-ish default; deliberately not 7681 (ttyd) or common dev ports.
export const DEFAULT_WEB_PORT = 7683;
export const IPV4_WILDCARD_HOST = "0.0.0.0";
export const IPV6_WILDCARD_HOST = "::";
export const LOOPBACK_HOST = "127.0.0.1";
// This computer only: there is no TLS, so the password and the session cookie would cross any other network in
// plain text. Every network, or one interface such as Tailscale, is the user's choice in Settings.
export const DEFAULT_WEB_HOST = LOOPBACK_HOST;

/** True for a listen address that binds every interface (IPv4 or IPv6). */
export function isWildcardHost(host: string): boolean {
  return host === IPV4_WILDCARD_HOST || host === IPV6_WILDCARD_HOST;
}

/** True for an address only this computer can reach: 127/8, ::1, and 127/8 mapped into IPv6 (::ffff:127.0.0.1,
 *  which Node also binds and reports as such). */
export function isLoopbackHost(host: string): boolean {
  if (net.isIPv4(host)) return host.startsWith("127.");
  if (!net.isIPv6(host)) return false;
  // The URL parser writes every spelling of one IPv6 address the same way: ::1 for 0:0:0:0:0:0:0:1, ::ffff:7f00:1
  // for ::ffff:127.0.0.1.
  const canonical = new URL(`http://[${host}]`).hostname.slice(1, -1);
  return canonical === "::1" || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(canonical);
}

/** A listen address Settings may save: an IP literal, wildcards included. Null for anything else (a name would be
 *  resolved by the OS at every start and could move). */
export function normalizeWebHost(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const host = value.trim();
  return net.isIP(host) ? host : null;
}

export interface WebInterfaceAddress {
  name: string;
  address: string;
}

/** The non-internal IPv4 addresses in an os.networkInterfaces() result, in its order. */
export function webInterfaceAddresses(
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): WebInterfaceAddress[] {
  const out: WebInterfaceAddress[] = [];
  for (const [name, infos] of Object.entries(interfaces)) {
    for (const info of infos ?? []) {
      if (info.family === "IPv4" && !info.internal) out.push({ name, address: info.address });
    }
  }
  return out;
}

/** Reachable URLs for Settings: the pinned address, or every non-internal IPv4 one when listening on all
 *  interfaces. */
export function webServerUrls(
  config: Pick<WebConfig, "host" | "port">,
  interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>,
): string[] {
  const urlHost = (host: string) => (net.isIPv6(host) ? `[${host}]` : host);
  if (!isWildcardHost(config.host)) {
    return [`http://${urlHost(config.host)}:${config.port}`];
  }
  const hosts = webInterfaceAddresses(interfaces).map((entry) => entry.address);
  if (hosts.length === 0) hosts.push(LOOPBACK_HOST);
  return hosts.map((host) => `http://${host}:${config.port}`);
}

const SCRYPT_KEYLEN = 32;
// Random bytes in a generated password (~78 bits) and in a password salt.
export const PASSWORD_BYTES = 10;
export const SALT_BYTES = 16;
export const MAX_TCP_PORT = 65535;

export interface WebConfig {
  enabled: boolean;
  port: number;
  /** Listen address: 127.0.0.1 by default, 0.0.0.0 for every interface, or one interface address such as
   *  Tailscale's. */
  host: string;
  /** True once the user picked the address in Settings. Configs written before the loopback default saved 0.0.0.0
   *  without anyone choosing it; see normalizeWebConfig. */
  hostChosen?: boolean;
  user: string;
  passwordHash: string; // scrypt, hex
  passwordSalt: string; // hex
  /** Plaintext of the auto-generated password (display in Settings).
   *  Absent once the user sets a custom password. */
  generatedPassword?: string;
}

export function defaultWebUser(): string {
  try {
    return os.userInfo().username;
  } catch {
    return "aya";
  }
}

/** URL-safe, human-typeable secret (~78 bits). */
export function generateWebPassword(): string {
  return crypto.randomBytes(PASSWORD_BYTES).toString("base64url");
}

export function hashWebPassword(password: string, saltHex: string): string {
  return crypto
    .scryptSync(password, Buffer.from(saltHex, "hex"), SCRYPT_KEYLEN)
    .toString("hex");
}

/** Build the stored credential fields for a (possibly generated) password. */
export function webCredentials(
  password: string,
  generated: boolean,
): Pick<WebConfig, "passwordHash" | "passwordSalt" | "generatedPassword"> {
  const passwordSalt = crypto.randomBytes(SALT_BYTES).toString("hex");
  return {
    passwordHash: hashWebPassword(password, passwordSalt),
    passwordSalt,
    ...(generated ? { generatedPassword: password } : {}),
  };
}

/** Constant-time password check against the stored hash. */
export function verifyWebPassword(
  config: Pick<WebConfig, "passwordHash" | "passwordSalt">,
  password: string,
): boolean {
  if (!config.passwordHash || !config.passwordSalt) return false;
  try {
    const expected = Buffer.from(config.passwordHash, "hex");
    const actual = Buffer.from(
      hashWebPassword(password, config.passwordSalt),
      "hex",
    );
    return (
      expected.length === actual.length &&
      crypto.timingSafeEqual(expected, actual)
    );
  } catch {
    return false;
  }
}

export function normalizeWebPort(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_TCP_PORT
    ? value
    : DEFAULT_WEB_PORT;
}

/** Normalize a raw web.json shape. Returns null when the file is unusable
 *  (caller regenerates a fresh default config). */
export function normalizeWebConfig(raw: unknown): WebConfig | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  if (typeof r.passwordHash !== "string" || !r.passwordHash) return null;
  if (typeof r.passwordSalt !== "string" || !r.passwordSalt) return null;
  const user =
    typeof r.user === "string" && r.user.trim()
      ? r.user.trim()
      : defaultWebUser();
  const enabled = r.enabled === true;
  const hostChosen = r.hostChosen === true;
  let host =
    typeof r.host === "string" && r.host.trim() ? r.host.trim() : DEFAULT_WEB_HOST;
  // Before the loopback default every config saved 0.0.0.0 on first run. One that is off and whose address nobody
  // picked moves to this computer only; one that is on keeps serving where its user reaches it today.
  if (!enabled && !hostChosen && host === IPV4_WILDCARD_HOST) host = DEFAULT_WEB_HOST;
  return {
    enabled,
    port: normalizeWebPort(r.port),
    host,
    ...(hostChosen ? { hostChosen } : {}),
    user,
    passwordHash: r.passwordHash,
    passwordSalt: r.passwordSalt,
    ...(typeof r.generatedPassword === "string" && r.generatedPassword
      ? { generatedPassword: r.generatedPassword }
      : {}),
  };
}

export function defaultWebConfig(): WebConfig {
  return {
    enabled: false,
    port: DEFAULT_WEB_PORT,
    host: DEFAULT_WEB_HOST,
    user: defaultWebUser(),
    ...webCredentials(generateWebPassword(), true),
  };
}

/** Load ~/.aya/web.json, creating (and persisting) a disabled default config
 *  with a freshly generated password on first use or when the file is
 *  malformed. */
/** The saved config; a fresh default when there is none or it is malformed. A file that exists but cannot be read
 *  now (EACCES, EMFILE, EISDIR) is an error, not a file to replace: replacing it would silently drop the user's
 *  password and turn Aya Web off. */
export async function loadWebConfig(): Promise<WebConfig> {
  let raw: string | null = null;
  try {
    raw = await fs.readFile(WEB_CONFIG_FILE, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  if (raw !== null) {
    try {
      const parsed = normalizeWebConfig(JSON.parse(raw));
      if (parsed) return parsed;
    } catch {
      // Malformed JSON: replaced by a fresh default below.
    }
  }
  const fresh = defaultWebConfig();
  await saveWebConfig(fresh);
  return fresh;
}

export async function saveWebConfig(config: WebConfig): Promise<void> {
  // Owner-only from the moment the file exists: it holds credential material, the first-run password in plain text
  // among it. Written with the default mode and chmodded after, it was readable by other users in between. The temp
  // file is created 0600 and renamed over web.json, so an older, wider file is replaced, not kept.
  await writeFileAtomic(
    WEB_CONFIG_FILE,
    JSON.stringify(config, null, 2) + "\n",
    OWNER_ONLY_FILE_MODE,
  );
  // The creation mode passes through the umask; an odd one could leave the owner unable to read the file back.
  await fs.chmod(WEB_CONFIG_FILE, OWNER_ONLY_FILE_MODE);
}
