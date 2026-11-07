// What Enter does in the Conversation GUI composer while the agent works.

import { test } from "node:test";
import assert from "node:assert/strict";
import { followUpHint, parseFollowUpPreference, sendAction, sendLabel } from "../dist-test/gui-composer.js";

const base = { mustWait: true, busy: true, steerSupported: true, preference: "queue", opposite: false, hasAttachments: false, isCommand: false };

test("an idle composer just sends", () => {
  assert.equal(sendAction({ ...base, mustWait: false, busy: false }), "send");
  assert.equal(sendAction({ ...base, mustWait: false, busy: false, opposite: true }), "send");
});

test("slash commands always run at once", () => {
  assert.equal(sendAction({ ...base, isCommand: true }), "send");
  assert.equal(sendAction({ ...base, isCommand: true, opposite: true }), "send");
});

test("while the agent works Enter follows the preference and Cmd+Enter does the opposite", () => {
  assert.equal(sendAction(base), "queue");
  assert.equal(sendAction({ ...base, opposite: true }), "steer");
  assert.equal(sendAction({ ...base, preference: "steer" }), "steer");
  assert.equal(sendAction({ ...base, preference: "steer", opposite: true }), "queue");
});

test("steering needs a running turn, an agent that supports it and no attachments", () => {
  assert.equal(sendAction({ ...base, preference: "steer", steerSupported: false }), "queue");
  assert.equal(sendAction({ ...base, preference: "steer", hasAttachments: true }), "queue");
  assert.equal(sendAction({ ...base, preference: "steer", busy: false }), "queue", "waiting behind a queue or a side question, no turn to steer");
});

test("the label and hint say what Enter will do", () => {
  assert.equal(sendLabel("send"), "Send ↑");
  assert.equal(sendLabel("queue"), "Queue ↑");
  assert.equal(sendLabel("steer"), "Steer ↗");
  assert.match(followUpHint("steer", true), /^Enter steers · ⌘Enter queues/);
  assert.match(followUpHint("queue", true), /^Enter queues · ⌘Enter steers/);
  assert.match(followUpHint("steer", false), /^Enter queues/);
});

test("the stored preference defaults to queue", () => {
  assert.equal(parseFollowUpPreference("steer"), "steer");
  assert.equal(parseFollowUpPreference("queue"), "queue");
  assert.equal(parseFollowUpPreference(null), "queue");
  assert.equal(parseFollowUpPreference("junk"), "queue");
});
