// Conversation GUI view options (tool calls, Zen) and screen-reader support (announcements, window title).

import { test } from "node:test";
import assert from "node:assert/strict";
import { isZenShortcut, memoizeByObject, parseGuiViewPrefs, visibleActivities, zenMessages } from "../dist-test/gui-view-prefs.js";
import { createAnnouncer, createWindowTitle, guiAnnouncement, guiWindowTitle } from "../dist-test/gui-a11y.js";

test("the view preference falls back to showing everything", () => {
  assert.deepEqual(parseGuiViewPrefs(null), { tools: "all", zen: false });
  assert.deepEqual(parseGuiViewPrefs("not json"), { tools: "all", zen: false });
  assert.deepEqual(parseGuiViewPrefs('{"tools":"failed","zen":true}'), { tools: "failed", zen: true });
  assert.deepEqual(parseGuiViewPrefs('{"tools":"weird"}'), { tools: "all", zen: false });
});

test("Hide successful keeps running and failed calls; Hide all hides every call", () => {
  const calls = [{ id: "a", status: "completed" }, { id: "b", status: "failed" }, { id: "c", status: "inProgress" }, { id: "d", status: "declined" }, { id: "e", status: "interrupted" }];
  assert.deepEqual(visibleActivities(calls, "all").map(c => c.id), ["a", "b", "c", "d", "e"]);
  assert.deepEqual(visibleActivities(calls, "failed").map(c => c.id), ["b", "c", "d"]);
  assert.deepEqual(visibleActivities(calls, "none"), []);
});

test("Zen keeps your messages and the last reply of each finished turn", () => {
  const messages = [
    { id: "u1", type: "user" }, { id: "a1", type: "assistant" }, { id: "t1", type: "settings" }, { id: "a2", type: "assistant" },
    { id: "u2", type: "user" }, { id: "p", type: "progress" }, { id: "q", type: "assistant", ask: true }, { id: "a3", type: "assistant" },
  ];
  const asks = m => m.ask === true;
  assert.deepEqual(zenMessages(messages, false, asks).map(m => m.id), ["u1", "a2", "u2", "q", "a3"]);
  // While the turn runs its replies are in-between messages: only the question stays.
  assert.deepEqual(zenMessages(messages, true, asks).map(m => m.id), ["u1", "a2", "u2", "q"]);
  assert.deepEqual(zenMessages([], false).map(m => m.id), []);
});

test("Zen's shortcut is Cmd/Ctrl+Alt+Z by physical key", () => {
  const key = { metaKey: true, ctrlKey: false, altKey: true, shiftKey: false, code: "KeyZ" };
  assert.equal(isZenShortcut(key), true);
  assert.equal(isZenShortcut({ ...key, metaKey: false, ctrlKey: true }), true);
  assert.equal(isZenShortcut({ ...key, altKey: false }), false);
  assert.equal(isZenShortcut({ ...key, shiftKey: true }), false);
});

test("announcements say when a turn starts, needs approval and ends, never on mount", () => {
  const working = { level: "active", text: "Claude is working" };
  assert.equal(guiAnnouncement(null, working), null);
  assert.equal(guiAnnouncement("clear", working), "Claude is working");
  assert.equal(guiAnnouncement(working, { level: "active", text: "1 subagent working in the background" }), null);
  assert.equal(guiAnnouncement(working, { level: "waiting", text: "Approval needed: rm x" }), "Approval needed: rm x");
  assert.equal(guiAnnouncement(working, { level: "done", text: "Turn complete" }), "Turn complete");
  assert.equal(guiAnnouncement({ level: "done", text: "Turn complete" }, { level: "done", text: "Turn complete" }), null);
  assert.equal(guiAnnouncement(working, "clear"), null);
});

test("the window title leads with the status only while it needs the user", () => {
  assert.equal(guiWindowTitle({ level: "active", text: "Claude is working" }, "Claude GUI"), "Working — Claude GUI — Aya");
  assert.equal(guiWindowTitle({ level: "waiting", text: "Approval needed: ls" }, "Claude GUI"), "Needs approval — Claude GUI — Aya");
  assert.equal(guiWindowTitle({ level: "waiting", text: "Claude has a question: Which?" }, "Claude GUI"), "Needs your input — Claude GUI — Aya");
  assert.equal(guiWindowTitle({ level: "error", text: "Limited · resets 15:00" }, "Claude GUI"), "Limited — Claude GUI — Aya");
  assert.equal(guiWindowTitle({ level: "done", text: "Turn complete" }, "Claude GUI"), null);
  assert.equal(guiWindowTitle("clear", "Claude GUI"), null);
});

test("one pane owns the title at a time and releasing it restores the window's own title", () => {
  const doc = { title: "Aya" };
  const title = createWindowTitle(doc);
  title.set("a", "Working — A");
  assert.equal(doc.title, "Working — A");
  title.set("b", "Needs approval — B");
  assert.equal(doc.title, "Needs approval — B");
  title.set("a", null);   // a pane that no longer owns it cannot reset it
  assert.equal(doc.title, "Needs approval — B");
  title.set("b", null);
  assert.equal(doc.title, "Aya");
  assert.equal(title.owner, null);
});

test("the same announcement twice is read twice: the region is emptied, then filled on the next frame", () => {
  const said = [], frames = [];
  const announce = createAnnouncer(text => said.push(text), run => frames.push(run));
  announce("Turn complete");
  frames.shift()();
  announce("Turn complete");
  frames.shift()();
  assert.deepEqual(said, ["", "Turn complete", "", "Turn complete"]);
  // A newer announcement wins over one still waiting for its frame.
  announce("Working"); announce("Approval needed");
  frames.forEach(run => run());
  assert.deepEqual(said.slice(4), ["", "", "Approval needed"]);
});

test("a message's questions are parsed once per message object, and again only when the message is replaced", () => {
  let parses = 0;
  const questionsOf = memoizeByObject(m => { parses++; return m.text.includes("?") ? [{ question: m.text }] : []; });
  const asked = { id: "a", type: "assistant", text: "Which one?" }, plain = { id: "b", type: "assistant", text: "Done" };
  const first = questionsOf(asked);
  assert.equal(questionsOf(asked), first, "the same result object, not a new parse");
  questionsOf(plain); questionsOf(plain);
  // Zen's filter over a conversation on every frame parses nothing new.
  for (let frame = 0; frame < 5; frame++) zenMessages([asked, plain], false, m => questionsOf(m).length > 0);
  assert.equal(parses, 2);
  // A streamed delta replaces the message: that one is parsed again.
  const extended = { ...asked, text: "Which one? A or B?" };
  assert.notEqual(questionsOf(extended), first);
  assert.deepEqual(questionsOf(extended), [{ question: "Which one? A or B?" }]);
  assert.equal(parses, 3);
});
