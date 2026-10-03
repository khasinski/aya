// The installed `aya` shim is executed, not just read: baked path x fallback x shell. Arguments
// and the exit code must reach the CLI unchanged under macOS /bin/sh (bash 3.2), dash and bash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderCliShim } from "../dist-electron/cli-shim.js";
import { COMMAND_NOT_FOUND_EXIT_CODE } from "../dist-electron/constants.js";
import { CLI_SHELLS, shellOptions } from "./helpers/cli-shells.mjs";

const ARGS = ["a b", "", "*", "$HOME", "-n", "it's"];
const WANT = ARGS.map((a) => `<${a}>`).join("");

for (const shell of CLI_SHELLS) {
  for (const baked of ["runs", "gone", "not executable"]) {
    for (const fallback of ["runs", "gone", "not executable", "none"]) {
      test(`shim x baked ${baked} x fallback ${fallback} x ${shell}`, shellOptions(shell), () => {
        const root = mkdtempSync(join(tmpdir(), "aya-shim-"));
        try {
          const dir = join(root, "My $Work", "it's `x`");
          mkdirSync(dir, { recursive: true });
          const cli = join(dir, "aya");
          writeFileSync(cli, '#!/bin/sh\nfor a; do printf "<%s>" "$a"; done\nexit 7\n');
          chmodSync(cli, 0o755);
          const plain = join(dir, "plain");
          writeFileSync(plain, "#!/bin/sh\necho must-not-run\n");
          chmodSync(plain, 0o644);
          const path = (state) => (state === "runs" ? cli : state === "gone" ? join(root, "missing", "aya") : plain);
          const shim = join(root, "shim");
          writeFileSync(shim, renderCliShim(path(baked), fallback === "none" ? null : path(fallback)));
          chmodSync(shim, 0o755);
          const r = spawnSync(shell, [shim, ...ARGS], { encoding: "utf8", env: { PATH: "/usr/bin:/bin", HOME: root } });
          if (baked === "runs" || fallback === "runs") {
            assert.equal(r.stdout, WANT);
            assert.equal(r.status, 7);
          } else {
            assert.equal(r.status, COMMAND_NOT_FOUND_EXIT_CODE);
            assert.equal(r.stdout, "");
            assert.match(r.stderr, /Reinstall/);
          }
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      });
    }
  }
}
