// Aya Web config: normalization round-trips, password hashing/verification,
// and the generated-vs-custom plaintext rule (the generated password is the
// ONLY one ever stored in plaintext — a custom password must leave no copy).

import { test } from "node:test";
import assert from "node:assert/strict";

const {
  DEFAULT_WEB_PORT,
  defaultWebConfig,
  generateWebPassword,
  normalizeWebConfig,
  normalizeWebPort,
  verifyWebPassword,
  webCredentials,
} = await import("../dist-electron/web-config.js");

test("defaultWebConfig is disabled with a verifiable generated password", () => {
  const config = defaultWebConfig();
  assert.equal(config.enabled, false);
  assert.equal(config.port, DEFAULT_WEB_PORT);
  assert.ok(config.user.length > 0);
  assert.ok(config.generatedPassword.length >= 10);
  assert.equal(verifyWebPassword(config, config.generatedPassword), true);
  assert.equal(verifyWebPassword(config, "wrong"), false);
});

test("custom credentials store no plaintext", () => {
  const creds = webCredentials("s3cret-password", false);
  assert.equal(creds.generatedPassword, undefined);
  assert.equal(verifyWebPassword(creds, "s3cret-password"), true);
  assert.equal(verifyWebPassword(creds, "s3cret-password "), false);
});

test("generated credentials keep the plaintext copy", () => {
  const password = generateWebPassword();
  const creds = webCredentials(password, true);
  assert.equal(creds.generatedPassword, password);
  assert.equal(verifyWebPassword(creds, password), true);
});

test("verifyWebPassword rejects malformed stored hashes", () => {
  assert.equal(
    verifyWebPassword({ passwordHash: "", passwordSalt: "" }, "x"),
    false,
  );
  assert.equal(
    verifyWebPassword(
      { passwordHash: "zz-not-hex", passwordSalt: "also-not-hex" },
      "x",
    ),
    false,
  );
});

test("normalizeWebPort clamps to a valid TCP port", () => {
  assert.equal(normalizeWebPort(8080), 8080);
  assert.equal(normalizeWebPort(0), DEFAULT_WEB_PORT);
  assert.equal(normalizeWebPort(65536), DEFAULT_WEB_PORT);
  assert.equal(normalizeWebPort(1.5), DEFAULT_WEB_PORT);
  assert.equal(normalizeWebPort("80"), DEFAULT_WEB_PORT);
  assert.equal(normalizeWebPort(undefined), DEFAULT_WEB_PORT);
});

test("normalizeWebConfig round-trips a full config", () => {
  const config = { ...defaultWebConfig(), enabled: true, port: 9000 };
  const parsed = normalizeWebConfig(JSON.parse(JSON.stringify(config)));
  assert.deepEqual(parsed, config);
});

test("normalizeWebConfig rejects configs without credentials", () => {
  assert.equal(normalizeWebConfig(null), null);
  assert.equal(normalizeWebConfig([]), null);
  assert.equal(normalizeWebConfig({ enabled: true }), null);
  assert.equal(
    normalizeWebConfig({ passwordHash: "aa" }), // missing salt
    null,
  );
});

test("normalizeWebConfig backfills defaults for optional fields", () => {
  const creds = webCredentials("pw", false);
  const parsed = normalizeWebConfig({ ...creds });
  assert.equal(parsed.enabled, false);
  assert.equal(parsed.port, DEFAULT_WEB_PORT);
  assert.equal(parsed.host, "0.0.0.0");
  assert.ok(parsed.user.length > 0);
  assert.equal(parsed.generatedPassword, undefined);
});
