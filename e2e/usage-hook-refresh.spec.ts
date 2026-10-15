// An installed usage hook is written only when the user installs it, so a fix to the script reaches an existing
// install only through Aya's launch, which rewrites an installed, outdated script (never installs one).

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, expect } from "./fixtures";

const OLD = "#!/usr/bin/env bash\n# an older build's usage hook\n";

test.use({ seedOptions: { ayaHomeFiles: { "aya-usage-hook.sh": OLD } } });

test("launch rewrites an installed usage hook from an older build", async ({ window, seeded }) => {
  void window;
  const file = join(seeded.ayaHome, "aya-usage-hook.sh");
  await expect.poll(() => readFileSync(file, "utf8"), { timeout: 15_000 }).toContain('cp "$TMP" "$TMP_OUT"');
  expect(statSync(file).mode & 0o777).toBe(0o755);
});
