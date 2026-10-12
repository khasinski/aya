// More of the Aya Web config, now on disk: loadWebConfig creating web.json on
// first use (owner-only, in a missing AYA_HOME), regenerating it when it is
// malformed or has no credentials, normalizing a hostile file without letting
// odd fields through, a custom password leaving no plaintext anywhere in the
// file, saveWebConfig tightening a loose file and replacing (not writing
// through) a symlink. Also the fallbacks: the user name when the OS has none,
// and a password check that throws inside counting as a wrong password.
// tests/web-config.test.mjs covers the pure normalization and hashing.
//
// Only Node built-ins are imported at the top: web-config is imported after
// AYA_HOME points at a temp dir that does not exist yet, so paths.ts never
// sees the real ~/.aya. Each scrypt hash takes tens of milliseconds, so the
// tests here make about a dozen of them in all.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  chmodSync,
  lstatSync,
} from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";

const root = mkdtempSync(join(tmpdir(), "aya-web-config-more-"));
const home = join(root, "home"); // created by the first save
process.env.AYA_HOME = home;

// Registered before the imports, so a failing import leaves no temp dir behind.
test.after(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.AYA_HOME;
});

const {
  DEFAULT_WEB_HOST,
  DEFAULT_WEB_PORT,
  WEB_CONFIG_FILE,
  defaultWebUser,
  loadWebConfig,
  saveWebConfig,
  verifyWebPassword,
  webCredentials,
} = await import("../dist-electron/web-config.js");

const mode = (file) => statSync(file).mode & 0o777;
const onDisk = () => JSON.parse(readFileSync(WEB_CONFIG_FILE, "utf-8"));
const leftoverTemps = () =>
  readdirSync(home).filter((name) => name.endsWith(".tmp"));

// One custom credential pair shared by the tests that only need a valid file.
const CUSTOM_PASSWORD = "correct horse battery staple";
const custom = webCredentials(CUSTOM_PASSWORD, false);

test("web.json lives in AYA_HOME", () => {
  assert.equal(WEB_CONFIG_FILE, join(home, "web.json"));
});

test("first load creates AYA_HOME and an owner-only web.json with a disabled default and a working generated password", async () => {
  assert.equal(existsSync(home), false);
  const config = await loadWebConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.port, DEFAULT_WEB_PORT);
  assert.equal(config.host, DEFAULT_WEB_HOST);
  assert.ok(config.generatedPassword);
  assert.equal(verifyWebPassword(config, config.generatedPassword), true);
  assert.equal(mode(WEB_CONFIG_FILE), 0o600);
  assert.deepEqual(onDisk(), config);
  assert.ok(readFileSync(WEB_CONFIG_FILE, "utf-8").endsWith("}\n"));
  assert.deepEqual(leftoverTemps(), []);
});

test("a second load returns the saved config and does not regenerate the password", async () => {
  const before = readFileSync(WEB_CONFIG_FILE, "utf-8");
  const config = await loadWebConfig();
  assert.deepEqual(config, JSON.parse(before));
  assert.equal(readFileSync(WEB_CONFIG_FILE, "utf-8"), before);
});

test("malformed or credential-less web.json is replaced by a fresh owner-only default", async () => {
  const unusable = [
    "{ not json",
    "",
    "null",
    "[]",
    '"a string"',
    JSON.stringify({ enabled: true, port: 9000, user: "me" }),
    JSON.stringify({ passwordHash: custom.passwordHash, passwordSalt: "" }),
    JSON.stringify({ passwordHash: 42, passwordSalt: custom.passwordSalt }),
  ];
  for (const text of unusable) {
    writeFileSync(WEB_CONFIG_FILE, text, { mode: 0o644 });
    chmodSync(WEB_CONFIG_FILE, 0o644);
    const config = await loadWebConfig();
    assert.equal(config.enabled, false, text);
    assert.equal(config.port, DEFAULT_WEB_PORT, text);
    assert.ok(config.generatedPassword, text);
    assert.match(config.passwordHash, /^[0-9a-f]{64}$/, text);
    assert.deepEqual(onDisk(), config, text);
    assert.equal(mode(WEB_CONFIG_FILE), 0o600, text);
  }
  assert.deepEqual(leftoverTemps(), []);
});

test("a hostile web.json is normalized: bad fields fall back, unknown keys and __proto__ are dropped", async () => {
  const hostile =
    "{" +
    '"enabled":"yes",' +
    '"port":"22",' +
    '"host":"   ",' +
    '"user":42,' +
    `"passwordHash":${JSON.stringify(custom.passwordHash)},` +
    `"passwordSalt":${JSON.stringify(custom.passwordSalt)},` +
    '"generatedPassword":123,' +
    '"isAdmin":true,' +
    '"__proto__":{"polluted":true}' +
    "}";
  writeFileSync(WEB_CONFIG_FILE, hostile);
  const config = await loadWebConfig();
  assert.deepEqual(config, {
    enabled: false,
    port: DEFAULT_WEB_PORT,
    host: DEFAULT_WEB_HOST,
    user: defaultWebUser(),
    passwordHash: custom.passwordHash,
    passwordSalt: custom.passwordSalt,
  });
  assert.equal(Object.getPrototypeOf(config), Object.prototype);
  assert.equal(config.polluted, undefined);
  assert.equal({}.polluted, undefined);
  assert.equal("generatedPassword" in config, false);
  // The stored credentials were kept, not regenerated.
  assert.equal(verifyWebPassword(config, CUSTOM_PASSWORD), true);
});

test("a loaded config keeps a valid listen address, user and port, trimmed", async () => {
  writeFileSync(
    WEB_CONFIG_FILE,
    JSON.stringify({
      enabled: true,
      port: 9443,
      host: "  100.64.0.7 ",
      user: "\tjustyna  ",
      ...custom,
      generatedPassword: "",
    }),
  );
  const config = await loadWebConfig();
  assert.deepEqual(config, {
    enabled: true,
    port: 9443,
    host: "100.64.0.7",
    user: "justyna",
    ...custom,
  });
});

test("a custom password saved over a generated one leaves no plaintext in web.json", async () => {
  const fresh = { ...(await loadWebConfig()), ...webCredentials("first-run-pw", true) };
  await saveWebConfig(fresh);
  assert.equal(onDisk().generatedPassword, "first-run-pw");

  // What Settings does on "set password": drop the plaintext, store a hash.
  const next = { ...fresh };
  delete next.generatedPassword;
  Object.assign(next, webCredentials(CUSTOM_PASSWORD, false));
  await saveWebConfig(next);

  const text = readFileSync(WEB_CONFIG_FILE, "utf-8");
  assert.equal(text.includes("first-run-pw"), false);
  assert.equal(text.includes(CUSTOM_PASSWORD), false);
  assert.equal(text.includes("generatedPassword"), false);
  const reloaded = await loadWebConfig();
  assert.equal("generatedPassword" in reloaded, false);
  assert.equal(verifyWebPassword(reloaded, CUSTOM_PASSWORD), true);
  assert.equal(verifyWebPassword(reloaded, "first-run-pw"), false);
  assert.equal(mode(WEB_CONFIG_FILE), 0o600);
});

test("saveWebConfig tightens a world-readable web.json to owner-only", async () => {
  chmodSync(WEB_CONFIG_FILE, 0o666);
  const config = onDisk();
  await saveWebConfig({ ...config, port: 9001 });
  assert.equal(mode(WEB_CONFIG_FILE), 0o600);
  assert.equal(onDisk().port, 9001);
});

test("saveWebConfig replaces a symlink planted at web.json instead of writing through it", async () => {
  const outside = join(root, "elsewhere.json");
  const outsideText = JSON.stringify({ ...custom, port: 9002 });
  writeFileSync(outside, outsideText);
  chmodSync(outside, 0o644);
  rmSync(WEB_CONFIG_FILE);
  symlinkSync(outside, WEB_CONFIG_FILE);

  // Reading follows the link: that file's credentials are what load returns.
  const loaded = await loadWebConfig();
  assert.equal(loaded.port, 9002);

  await saveWebConfig({ ...loaded, port: 9003 });
  assert.equal(lstatSync(WEB_CONFIG_FILE).isSymbolicLink(), false);
  assert.equal(onDisk().port, 9003);
  assert.equal(mode(WEB_CONFIG_FILE), 0o600);
  // The link target is untouched, content and mode.
  assert.equal(readFileSync(outside, "utf-8"), outsideText);
  assert.equal(mode(outside), 0o644);
});

test("a folder at web.json makes load reject and leaves no temp file behind", async () => {
  rmSync(WEB_CONFIG_FILE);
  mkdirSync(join(WEB_CONFIG_FILE, "inside"), { recursive: true });
  try {
    await assert.rejects(loadWebConfig());
    assert.ok(statSync(WEB_CONFIG_FILE).isDirectory());
    assert.ok(existsSync(join(WEB_CONFIG_FILE, "inside")));
    assert.deepEqual(leftoverTemps(), []);
  } finally {
    rmSync(WEB_CONFIG_FILE, { recursive: true, force: true });
  }
});

test("defaultWebUser falls back to aya when the OS has no user entry", (t) => {
  const real = os.userInfo().username;
  assert.equal(defaultWebUser(), real);
  t.mock.method(os, "userInfo", () => {
    throw Object.assign(new Error("no passwd entry"), { code: "ENOENT" });
  });
  assert.equal(defaultWebUser(), "aya");
});

test("verifyWebPassword: a check that throws inside is a wrong password, never an error", () => {
  // A password that is not a string makes scrypt throw.
  assert.equal(verifyWebPassword(custom, undefined), false);
  assert.equal(verifyWebPassword(custom, 1234), false);
  // A salt that is not a string (only reachable without normalizeWebConfig).
  assert.equal(
    verifyWebPassword({ passwordHash: custom.passwordHash, passwordSalt: {} }, CUSTOM_PASSWORD),
    false,
  );
});

test("verifyWebPassword rejects a stored hash that is cut short or one byte off", () => {
  assert.equal(verifyWebPassword(custom, CUSTOM_PASSWORD), true);
  const short = { ...custom, passwordHash: custom.passwordHash.slice(0, -2) };
  assert.equal(verifyWebPassword(short, CUSTOM_PASSWORD), false);
  const last = custom.passwordHash.slice(-2);
  const flipped = (parseInt(last, 16) ^ 1).toString(16).padStart(2, "0");
  const offByOne = {
    ...custom,
    passwordHash: custom.passwordHash.slice(0, -2) + flipped,
  };
  assert.equal(verifyWebPassword(offByOne, CUSTOM_PASSWORD), false);
});
