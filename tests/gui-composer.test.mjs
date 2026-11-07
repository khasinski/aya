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

import { quoteMarkdown, recallStep, sentPromptText, stashStep, withQuote } from "../dist-test/gui-composer.js";

test("ArrowUp walks back through sent prompts, ArrowDown forward, and past the newest clears", () => {
  const history = ["one", "two", "three"];
  let r = recallStep(history, null, "", "up", true);
  assert.deepEqual(r, { prompt: "three", recall: { index: 2, text: "three" } });
  r = recallStep(history, r.recall, r.prompt, "up", true);
  assert.equal(r.prompt, "two");
  r = recallStep(history, r.recall, r.prompt, "up", true);
  r = recallStep(history, r.recall, r.prompt, "up", true);
  assert.equal(r.prompt, "one", "stops at the oldest");
  r = recallStep(history, r.recall, r.prompt, "down", true);
  assert.equal(r.prompt, "two");
  r = recallStep(history, r.recall, r.prompt, "down", true);
  r = recallStep(history, r.recall, r.prompt, "down", true);
  assert.deepEqual(r, { prompt: "", recall: null });
});

test("recall leaves the arrows alone when text was typed, edited, or the caret is not on the edge line", () => {
  const history = ["one", "two"];
  assert.equal(recallStep(history, null, "typing", "up", true), null);
  assert.equal(recallStep(history, null, "", "up", false), null);
  assert.equal(recallStep(history, { index: 1, text: "two" }, "two edited", "up", true), null, "an edited recall is a draft");
  assert.equal(recallStep(history, null, "", "down", true), null);
  assert.equal(recallStep([], null, "", "up", true), null);
});

test("a steered message is recalled without its arrow", () => {
  assert.equal(sentPromptText("↳ look at the tests"), "look at the tests");
  assert.equal(sentPromptText("plain"), "plain");
});

test("a selection becomes a block quote placed after the draft", () => {
  assert.equal(quoteMarkdown("a\nb"), "> a\n> b\n\n");
  assert.equal(quoteMarkdown("a\n\nb"), "> a\n>\n> b\n\n");
  assert.equal(withQuote("", "hello"), "> hello\n\n");
  assert.equal(withQuote("my draft  \n", "hello"), "my draft\n\n> hello\n\n");
  assert.equal(withQuote("draft", "   "), "draft");
});

test("Cmd+S stashes a draft and brings the latest one back to an empty composer", () => {
  assert.deepEqual(stashStep([], "half a thought"), { prompt: "", stash: ["half a thought"] });
  assert.deepEqual(stashStep(["a", "b"], ""), { prompt: "b", stash: ["a"] });
  assert.equal(stashStep([], ""), null);
  assert.deepEqual(stashStep(["a"], "new"), { prompt: "", stash: ["a", "new"] });
});

import { LARGE_PASTE_BYTES, pasteBecomesAttachment } from "../dist-test/gui-composer.js";

test("a paste of 32 KiB or more, or one that would overflow the message, becomes an attachment", () => {
  assert.equal(pasteBecomesAttachment("short", 0), false);
  assert.equal(pasteBecomesAttachment("", 0), false);
  assert.equal(pasteBecomesAttachment("x".repeat(LARGE_PASTE_BYTES - 1), 0), false);
  assert.equal(pasteBecomesAttachment("x".repeat(LARGE_PASTE_BYTES), 0), true);
  assert.equal(pasteBecomesAttachment("é".repeat(LARGE_PASTE_BYTES / 2), 0), true, "bytes, not characters");
  assert.equal(pasteBecomesAttachment("x".repeat(20000), 90000), true, "would exceed 100000 characters");
  assert.equal(pasteBecomesAttachment("x".repeat(20000), 70000), false);
});
