import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** An empty repo in os.tmpdir that never depends on the host git config. */
export function makeRepo(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  // -q silences hint output; -b pins the branch so the tests don't depend on
  // the host git's init.defaultBranch.
  execSync("git init -q -b main", { cwd: root });
  execSync("git config user.email test@aya.invalid", { cwd: root });
  execSync('git config user.name "Aya Test"', { cwd: root });
  execSync("git config commit.gpgsign false", { cwd: root });
  return root;
}
