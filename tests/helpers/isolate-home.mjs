import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { installGuard, protectedFiles, protectedRoots } from "./real-config-guard.mjs";

const stamp = (file) => (existsSync(file) ? statSync(file).mtimeMs : null);

/** Fails the test process at exit if any watched file changed since now: the
 *  catch for a write the preload cannot see, a child process's. */
export function guardRealConfig(files = protectedFiles()) {
  const before = files.map(stamp);
  process.on("exit", (code) => {
    const changed = files.filter((file, i) => stamp(file) !== before[i]);
    if (changed.length === 0) return;
    console.error(`test wrote the real config: ${changed.join(", ")}`);
    process.exitCode = code || 1;
  });
}

/** Points HOME, AYA_HOME and the agent config dirs into `root`, and guards the real config,
 *  by the preload's write guard as well, so a test file run directly is covered. */
export function isolateHome(root, { files, roots = protectedRoots() } = {}) {
  guardRealConfig(files);
  installGuard(roots);
  process.env.HOME = join(root, "home");
  process.env.AYA_HOME = join(root, "aya");
  delete process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CODEX_HOME;
}
