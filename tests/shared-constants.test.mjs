// Pins shared, security-relevant values to one source of truth. The socket
// permission mode existed as two independent copies (pty-host.ts, control.ts)
// before being centralized - this test pins both the value and the location.

import { test } from "node:test";
import assert from "node:assert/strict";
import { SOCKET_FILE_PERMISSIONS } from "../dist-electron/paths.js";

test("control/pty-host sockets are owner-only (rw-------)", () => {
  assert.equal(SOCKET_FILE_PERMISSIONS, 0o600);
});
