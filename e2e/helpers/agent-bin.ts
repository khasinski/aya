import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A stand-in CLI as an executable named like the real one: Aya gives a session
 *  id only to a command whose program is the agent's own binary. */
export function agentBin(name: string, fake: string): string {
  const file = join(mkdtempSync(join(tmpdir(), `aya-e2e-${name}-bin-`)), name);
  writeFileSync(file, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, { mode: 0o755 });
  return file;
}

/** The stand-in that writes its argv and env to ARGV_DUMP_FILE (see argv-dump.cjs). */
export const ARGV_DUMP = join(__dirname, "argv-dump.cjs");

/** Where that file lands, as shell text: per terminal, in the project dir. */
export const ARGV_DUMP_FILE = '"$AYA_PROJECT_DIR/argv-$AYA_TERMINAL_ID.json"';

/** Shell text running ARGV_DUMP, for a preset command or a stub's last line. */
export const ARGV_DUMP_COMMAND = `'${process.execPath}' '${ARGV_DUMP}' ${ARGV_DUMP_FILE}`;
