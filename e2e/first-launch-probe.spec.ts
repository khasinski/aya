import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";
import { AGENT_TEST_TIMEOUT_MS, SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { launchApp } from "./helpers/relaunch";
import { PAST_PROBE_MS } from "./helpers/seed";

// A login shell slower than the 2.5 s probe (19 parallel measured 2.3-4.8 s under load) must not hide an
// installed Claude; when PATH cannot be repaired, a shell that does not answer leaves the scan unsaved.

const savedIds = (file: string) => JSON.parse(readFileSync(file, "utf8")).presets.map((p: { id: string }) => p.id);

test.describe("PATH repaired by a slow login shell", () => {
  test.use({ seedOptions: { presets: false, slowLoginShell: { delayMs: PAST_PROBE_MS, cli: "claude" } } });

  test("the first launch shows and saves Claude", async ({ seeded }) => {
    test.setTimeout(60_000);
    const { app, window } = await launchApp(seeded);
    try {
      await expect(window.locator(".aya-launcher-btn", { hasText: "Claude Code" })).toBeVisible({ timeout: SLOW_EXPECT_TIMEOUT_MS });
      await expect.poll(() => existsSync(join(seeded.ayaHome, "presets.json"))).toBe(true);
      expect(savedIds(join(seeded.ayaHome, "presets.json"))).toEqual(expect.arrayContaining(["claude", "shell"]));
    } finally {
      await app.close().catch(() => undefined);
    }
  });
});

test.describe("PATH not repaired: the login shell is too slow", () => {
  test.use({ seedOptions: { presets: false } });

  test("a first launch saves nothing; the next launch that answers seeds Claude", async ({ seeded }) => {
    test.setTimeout(AGENT_TEST_TIMEOUT_MS);
    // Claude only on the PATH the login shell's rc builds; the shell outlasts the 5 s PATH repair.
    const rcBin = join(seeded.root, "rc-bin");
    mkdirSync(rcBin, { recursive: true });
    writeFileSync(join(rcBin, "claude"), "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
    const shell = join(seeded.root, "rc-login-shell");
    writeFileSync(
      shell,
      `#!/bin/sh\nsleep 6\nPATH='${rcBin}':$PATH\nexport PATH\nwhile [ "$#" -gt 0 ]; do\n  case "$1" in -c) shift; exec /bin/sh -c "$1" ;; *) shift ;; esac\ndone\n`,
    );
    chmodSync(shell, 0o755);
    seeded.launchEnv = { ...seeded.launchEnv, SHELL: shell, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" };
    const presetsFile = join(seeded.ayaHome, "presets.json");

    const first = await launchApp(seeded);
    let second: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      await expect(first.window.locator(".aya-launcher-btn", { hasText: "Shell" })).toBeVisible({ timeout: SLOW_EXPECT_TIMEOUT_MS });
      expect(existsSync(presetsFile), "an unanswered scan is not saved as 'nothing installed'").toBe(false);
      await first.app.close();
      writeFileSync(shell, readFileSync(shell, "utf8").replace(/^sleep .*$/m, ""));
      second = await launchApp(seeded);
      await expect(second.window.locator(".aya-launcher-btn", { hasText: "Claude Code" })).toBeVisible({ timeout: SLOW_EXPECT_TIMEOUT_MS });
      expect(savedIds(presetsFile)).toEqual(["claude", "shell"]);
    } finally {
      await first.app.close().catch(() => undefined);
      await second?.app.close().catch(() => undefined);
    }
  });
});
