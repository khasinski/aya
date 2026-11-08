import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { fetchUserRuleFile } from "../dist-electron/screen-rule-fetch.js";
import { loadBundledScreenRules } from "../dist-electron/screen-rule-data.js";

const builtin = loadBundledScreenRules(path.resolve("electron/screen-rules"));
const good = Buffer.from(JSON.stringify({ schemaVersion: 1, ruleSetVersion: "u1", agent: "claude", rules: [] }));

function home() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aya-fetch-"));
  const directory = path.join(root, "screen-rules");
  return { root, directory };
}
const base = (h, extra) => ({ url: "https://example.test/c.json", agent: "claude", replace: false, directory: h.directory, builtin, fetchBytes: async () => good, ...extra });

test("fetch writes a validated 0600 file", async () => {
  const h = home();
  const done = await fetchUserRuleFile(base(h));
  assert.equal(done.replaced, false);
  assert.equal(fs.statSync(done.path).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(h.directory), ["claude.json"]);
  assert.deepEqual(fs.readdirSync(h.root), ["screen-rules"]);
});

test("fetch refuses http, credentials, unknown agents and overwriting", async () => {
  const h = home();
  await assert.rejects(fetchUserRuleFile(base(h, { url: "http://example.test/c.json" })), /https/);
  await assert.rejects(fetchUserRuleFile(base(h, { url: "https://u:p@example.test/c.json" })), /user name/);
  await assert.rejects(fetchUserRuleFile(base(h, { agent: "../x" })), /unknown agent/);
  await fetchUserRuleFile(base(h));
  await assert.rejects(fetchUserRuleFile(base(h)), /--replace/);
  assert.equal((await fetchUserRuleFile(base(h, { replace: true }))).replaced, true);
});

test("fetch leaves nothing behind for an invalid or failing download", async () => {
  const h = home();
  await assert.rejects(fetchUserRuleFile(base(h, { fetchBytes: async () => Buffer.from("not json") })), /not a valid rule file/);
  await assert.rejects(fetchUserRuleFile(base(h, { fetchBytes: async () => { throw new Error("boom"); } })), /could not fetch/);
  assert.equal(fs.existsSync(path.join(h.directory, "claude.json")), false);
});

test("fetch times out", async () => {
  const h = home();
  const hang = (_u, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  await assert.rejects(fetchUserRuleFile(base(h, { fetchBytes: hang, timeoutMs: 20 })), /in time/);
});
