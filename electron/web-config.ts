// Aya Web (experimental) — persistence for the browser-access server config.
//
// Stored at ~/.aya/web.json with owner-only permissions. Passwords are kept
// as scrypt hashes; ONLY the auto-generated first-run password is also kept
// in plaintext (`generatedPassword`) so the Settings UI can display it. When
// the user sets a custom password the plaintext copy is cleared and never
// stored again.

import * as crypto from "node:crypto";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeFileAtomic } from "./atomic-write";
import { AYA_HOME, OWNER_ONLY_FILE_MODE } from "./paths";

export const WEB_CONFIG_FILE = path.join(AYA_HOME, "web.json");

// Unassigned-ish default; deliberately not 7681 (ttyd) or common dev ports.
export const DEFAULT_WEB_PORT = 7683;
export const DEFAULT_WEB_HOST = "0.0.0.0";

const SCRYPT_KEYLEN = 32;

export interface WebConfig {
  enabled: boolean;
  port: number;
  /** Listen address. 0.0.0.0 = every interface (remote access is the point);
   *  users can pin it to a VPN/Tailscale interface address instead. */
  host: string;
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
  return crypto.randomBytes(10).toString("base64url");
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
  const passwordSalt = crypto.randomBytes(16).toString("hex");
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
    value <= 65535
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
  return {
    enabled: r.enabled === true,
    port: normalizeWebPort(r.port),
    host:
      typeof r.host === "string" && r.host.trim()
        ? r.host.trim()
        : DEFAULT_WEB_HOST,
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
export async function loadWebConfig(): Promise<WebConfig> {
  try {
    const raw = await fs.readFile(WEB_CONFIG_FILE, "utf-8");
    const parsed = normalizeWebConfig(JSON.parse(raw));
    if (parsed) return parsed;
  } catch {
    // ENOENT or malformed — fall through to a fresh default.
  }
  const fresh = defaultWebConfig();
  await saveWebConfig(fresh);
  return fresh;
}

export async function saveWebConfig(config: WebConfig): Promise<void> {
  await writeFileAtomic(
    WEB_CONFIG_FILE,
    JSON.stringify(config, null, 2) + "\n",
  );
  // Owner-only: the file holds credential material.
  await fs.chmod(WEB_CONFIG_FILE, OWNER_ONLY_FILE_MODE);
}
