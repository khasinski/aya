// web.json holds Aya Web's credentials, the first-run password in plain text among them. It must be owner-only from
// the moment it exists, not chmodded after a write with the default mode; and a web.json that exists but cannot be
// read now is an error, not a file to replace with a fresh default (a new password, Aya Web off).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

const home = mkdtempSync(join(tmpdir(), "aya-web-owner-"));
// A permissive umask, as most users have: under 077 a default-mode write would come out 0600 anyway and prove nothing.
const umask = process.umask(0o022);
process.env.AYA_HOME = home;
test.after(() => {
  process.umask(umask);
  chmodSync(join(home, "web.json"), 0o600);
  rmSync(home, { recursive: true, force: true });
});
// The CommonJS fs the compiled writer calls (an ESM namespace cannot be mocked).
const fsCjs = createRequire(import.meta.url)("node:fs");
const { loadWebConfig } = await import("../dist-electron/web-config.js");
const file = join(home, "web.json");

test("the first web.json is owner-only already as the temp file the password is written to", async (t) => {
  const seen = [];
  const rename = fsCjs.promises.rename;
  t.mock.method(fsCjs.promises, "rename", async (from, to) => {
    if (to === file) seen.push({ mode: statSync(from).mode & 0o777, text: readFileSync(from, "utf8") });
    return rename(from, to);
  });
  const config = await loadWebConfig();
  assert.equal(seen.length, 1, "written once, through a temp file");
  assert.match(seen[0].text, /generatedPassword/, "the plain-text first-run password is in it");
  assert.equal(seen[0].mode, 0o600, "owner-only before it is web.json");
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal(typeof config.generatedPassword, "string");
});

test("a web.json that cannot be read is an error, and the file and its password stay", { skip: process.getuid?.() === 0 && "root reads it anyway" }, async () => {
  const before = readFileSync(file, "utf8");
  chmodSync(file, 0o000);
  try {
    await assert.rejects(loadWebConfig(), { code: "EACCES" });
  } finally {
    chmodSync(file, 0o600);
  }
  assert.equal(readFileSync(file, "utf8"), before, "not replaced by a fresh default");
});
