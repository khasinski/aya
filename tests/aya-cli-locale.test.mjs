// BSD tr (macOS) refuses bytes that are not valid in a UTF-8 locale ("tr: Illegal byte sequence";
// GNU tr does not), so `aya team save` must not pass a file's bytes through it.

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CLI_SHELLS, runCli, shellOptions, stubApp } from "./helpers/cli-shells.mjs";

const LOCALES = ["en_US.UTF-8", "C"];
const FILES = {
  "valid UTF-8": { bytes: Buffer.from("# t\n\n## Role: a\nzażółć gęślą\n"), saved: true },
  "invalid UTF-8 among text": { bytes: Buffer.concat([Buffer.from("# t\n## Role: a\n"), Buffer.from([0xb1, 0xea]), Buffer.from(" x\n")]), saved: true },
  "only invalid UTF-8": { bytes: Buffer.from([0xb1, 0xea, 0xb3]), saved: true },
  "only whitespace": { bytes: Buffer.from(" \n\t\n"), saved: false },
  "empty": { bytes: Buffer.alloc(0), saved: false },
};

async function save(shell, locale, bytes) {
  const dir = mkdtempSync(join(tmpdir(), "aya-loc-"));
  const socket = join(dir, "aya.sock");
  const file = join(dir, "team.md");
  writeFileSync(file, bytes);
  const app = await stubApp(socket);
  try {
    const env = { PATH: process.env.PATH, HOME: dir, LC_ALL: locale, AYA_SOCKET: socket };
    const result = await runCli(shell, ["team", "save", file], env);
    return { ...result, request: app.requests[0] ?? null };
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

// Every matrix cell owns its HOME, socket, server and input file. Keep every
// shell/locale/byte combination while overlapping their independent launches.
describe("locale matrix with independent control sockets", { concurrency: 4 }, () => {
  for (const [name, { bytes, saved }] of Object.entries(FILES)) {
    for (const locale of LOCALES) {
      for (const shell of CLI_SHELLS) {
        test(`team save of ${name} x locale ${locale} x ${shell}`, shellOptions(shell), async () => {
          const { status, stderr, request } = await save(shell, locale, bytes);
          if (saved) {
            assert.equal(stderr, "");
            assert.equal(status, 0);
            assert.equal(request.type, "team-save");
            assert.ok(request.text.length > 0);
          } else {
            assert.equal(status, 1);
            assert.match(stderr, /is empty; nothing was saved/);
            assert.equal(request, null);
          }
        });
      }
    }
  }
});
