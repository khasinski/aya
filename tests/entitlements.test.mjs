// Guards the macOS microphone fix: terminal tools the user runs (e.g. a /voice
// plugin) need the host app to carry the audio-input entitlement, otherwise the
// hardened runtime blocks the mic for Aya and every process it spawns. A plain
// config-presence check — cheap, and the only honest way to assert a packaging
// detail that can't be exercised by an e2e.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("hardened-runtime entitlements grant microphone (audio-input)", () => {
  const plist = readFileSync(
    path.join(root, "build", "entitlements.mac.plist"),
    "utf8",
  );
  assert.match(
    plist,
    /<key>com\.apple\.security\.device\.audio-input<\/key>\s*<true\/>/,
    "build/entitlements.mac.plist must grant com.apple.security.device.audio-input",
  );
});

test("microphone usage description explains why and how to revoke", () => {
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const desc = pkg.build?.mac?.extendInfo?.NSMicrophoneUsageDescription;
  assert.equal(typeof desc, "string", "NSMicrophoneUsageDescription must be set");
  assert.ok(
    desc.length > 0 && /System Settings/i.test(desc),
    "usage description should explain the capability and point to System Settings",
  );
});
