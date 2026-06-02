// Seed-on-fresh-install flow for snippets (mirrors how presets seed
// DEFAULT_PRESETS the first time the app runs). Exercises the real
// listSnippets() side effect against a throwaway AYA_HOME, not just the
// shape of DEFAULT_SNIPPETS.
//
// IMPORTANT: only Node built-ins are statically imported here. The snippets
// module is imported DYNAMICALLY *after* AYA_HOME is pointed at a temp dir —
// a static import would be hoisted and freeze paths.ts to the real ~/.aya
// before we could redirect it. `node --test` runs each test file in its own
// process, so this redirection can't leak into the other suites.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("listSnippets seeds DEFAULT_SNIPPETS on a fresh install and persists them", async () => {
  const home = mkdtempSync(join(tmpdir(), "aya-snip-seed-"));
  process.env.AYA_HOME = home;
  try {
    const { listSnippets, DEFAULT_SNIPPETS } = await import(
      "../dist-electron/snippets.js"
    );
    const file = join(home, "snippets.json");

    assert.ok(!existsSync(file), "precondition: no snippets file in a fresh home");

    const seeded = await listSnippets();
    assert.deepEqual(
      seeded,
      [...DEFAULT_SNIPPETS],
      "first run returns the shipped defaults",
    );
    assert.ok(existsSync(file), "seeding persists the file (like presets do)");

    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    assert.deepEqual(
      onDisk.snippets,
      [...DEFAULT_SNIPPETS],
      "persisted file holds the defaults under the `snippets` key",
    );

    // A second call must read the persisted file, not re-seed from scratch.
    const second = await listSnippets();
    assert.deepEqual(second, [...DEFAULT_SNIPPETS], "second run reads persisted snippets");
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AYA_HOME;
  }
});

test("listSnippets does NOT overwrite an existing snippets file with defaults", async () => {
  const home = mkdtempSync(join(tmpdir(), "aya-snip-keep-"));
  process.env.AYA_HOME = home;
  try {
    const { saveSnippets, listSnippets } = await import(
      "../dist-electron/snippets.js"
    );
    const custom = [{ id: "mine", name: "mine", text: "echo hi", autoRun: true }];
    await saveSnippets(custom);

    const loaded = await listSnippets();
    assert.deepEqual(loaded, custom, "existing user snippets survive — no re-seed");
  } finally {
    rmSync(home, { recursive: true, force: true });
    delete process.env.AYA_HOME;
  }
});
