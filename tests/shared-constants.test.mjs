// Pins shared, security-relevant and cross-module values to one source of
// truth. Several existed as independent literal copies before centralization
// (socket perms in pty-host.ts + control.ts; 2500ms probe timeout in
// harnesses.ts + pty.ts + main.ts; exit 127 in pty.ts + cli-shim.ts) - these
// tests pin both the value and the single location.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOCKET_FILE_PERMISSIONS, OWNER_ONLY_FILE_MODE } from "../dist-electron/paths.js";
import {
  COMMAND_NOT_FOUND_EXIT_CODE,
  COMMAND_PROBE_TIMEOUT_MS,
} from "../dist-electron/constants.js";
import { PS_LSTART_WIDTH } from "../dist-electron/pty-host-registry.js";
import { SUMMARY_TEXT_MAX_CHARS } from "../dist-electron/local-summary-errors.js";

test("control/pty-host sockets are owner-only (rw-------)", () => {
  assert.equal(SOCKET_FILE_PERMISSIONS, 0o600);
});

test("owner-only file mode is 0o600 and the socket mode derives from it", () => {
  assert.equal(OWNER_ONLY_FILE_MODE, 0o600);
  assert.equal(SOCKET_FILE_PERMISSIONS, OWNER_ONLY_FILE_MODE);
});

test("command-not-found exit code is the POSIX 127", () => {
  assert.equal(COMMAND_NOT_FOUND_EXIT_CODE, 127);
});

test("external-command probe timeout is 2.5s", () => {
  assert.equal(COMMAND_PROBE_TIMEOUT_MS, 2_500);
});

test("ps lstart field width matches the C-locale ctime format (24 chars)", () => {
  assert.equal(PS_LSTART_WIDTH, 24);
  // The format the width encodes - a literal C-locale ctime example:
  assert.equal("Wed Jul  2 10:00:00 2026".length, PS_LSTART_WIDTH);
});

test("summary text cap is 160 chars", () => {
  assert.equal(SUMMARY_TEXT_MAX_CHARS, 160);
});
