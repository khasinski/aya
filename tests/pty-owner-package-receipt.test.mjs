import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
const { verifyBuildReceipt } = createRequire(import.meta.url)("../scripts/package-owner-smoke.cjs");
test("package smoke rejects a stale or tampered native artifact instead of blessing its newly recorded hash", () => {
  fs.mkdirSync("test-results", { recursive: true });
  const dir = fs.mkdtempSync(path.resolve("test-results/owner-receipt-"));
  try {
    const owner = Buffer.from("owner"), bridge = Buffer.from("bridge");
    fs.writeFileSync(path.join(dir, "aya-pty-owner"), owner); fs.writeFileSync(path.join(dir, "pty-owner-bridge.node"), bridge);
    const hash = bytes => createHash("sha256").update(bytes).digest("hex");
    const receipt = { ownerHash: hash(owner), bridgeHash: hash(bridge) };
    assert.doesNotThrow(() => verifyBuildReceipt(dir, receipt));
    fs.appendFileSync(path.join(dir, "aya-pty-owner"), "stale");
    assert.throws(() => verifyBuildReceipt(dir, receipt), /does not match the build receipt/);
    fs.writeFileSync(path.join(dir, "aya-pty-owner"), owner); fs.appendFileSync(path.join(dir, "pty-owner-bridge.node"), "stale");
    assert.throws(() => verifyBuildReceipt(dir, receipt), /does not match the build receipt/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
