import { test } from "node:test";
import assert from "node:assert/strict";

import { uuid } from "../dist-test/uuid.js";

test("renderer ids are 16 lowercase hex characters, fresh each call", () => {
  const ids = Array.from({ length: 50 }, () => uuid());
  for (const id of ids) assert.match(id, /^[0-9a-f]{16}$/);
  assert.equal(new Set(ids).size, ids.length);
});
