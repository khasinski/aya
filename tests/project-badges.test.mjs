import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateProjectBadges } from "../dist-test/project-badges.js";

const terminal = (id, projectSlug = "demo", over = {}) => ({
  id,
  projectSlug,
  presetId: "claude",
  name: id,
  cwd: `/${projectSlug}`,
  status: "running",
  bell: false,
  exitCode: null,
  ...over,
});
const session = (id, level, cwd = "/demo") => ({
  id, level, cwd, source: "codex", text: id, updatedAt: 1,
});
const record = (items) => Object.fromEntries(items.map((item) => [item.id, item]));
const project = (slug) => ({ slug, name: slug, directory: `/${slug}`, tabs: [] });
const projects = [project("demo"), project("other")];
const resolveSession = (session, projects) =>
  projects.find((project) => project.directory === session.cwd)?.slug ?? null;
const calculate = (terminals = {}, sessions = []) =>
  calculateProjectBadges(terminals, sessions, projects, resolveSession);

test("empty and unclassified terminals produce no badges", () => {
  const empty = { projectBadges: {}, monitoredSessionsByProject: {}, attentionCount: 0 };
  assert.deepEqual(calculate(), empty);
  assert.deepEqual(calculate(record([
    terminal("running"),
    terminal("shell", "demo", { presetId: "shell", status: "idle", exitCode: 0 }),
    terminal("teammate", "demo", { status: "idle", externalStatus: { level: "waiting-on", on: "tester" } }),
  ])), empty);
});

test("terminal classification contributes active, done, waiting and error badges", () => {
  const result = calculate(record([
    terminal("active", "active", { externalStatus: { level: "active" } }),
    terminal("done", "done", { status: "idle", exitCode: 0 }),
    terminal("waiting", "waiting", { bell: true }),
    terminal("error", "error", { spawnFailure: { reason: "command-not-found", detail: "missing" } }),
  ]));
  assert.deepEqual(result, {
    projectBadges: {
      active: { count: 1, level: "active" }, done: { count: 1, level: "done" },
      waiting: { count: 1, level: "waiting" }, error: { count: 1, level: "error" },
    },
    monitoredSessionsByProject: {}, attentionCount: 3,
  });
});

const levels = ["active", "done", "waiting", "error"];
for (const first of levels) {
  for (const second of levels) {
    test(`badge severity preserves the higher level for ${first} then ${second}`, () => {
      const level = levels[Math.max(levels.indexOf(first), levels.indexOf(second))];
      const sessions = [session("first", first), session("second", second)];
      assert.deepEqual(calculate({}, sessions), {
        projectBadges: { demo: { count: 2, level } },
        monitoredSessionsByProject: { demo: sessions },
        attentionCount: level === "active" ? 0 : 2,
      });
    });
  }
}

test("sessions group by the supplied project matcher in input order and keep their identity", () => {
  const sessions = [
    session("other-first", "active", "/other"), session("demo-first", "done"),
    session("unmatched", "error", "/closed"), session("other-second", "waiting", "/other"),
    session("demo-second", "error"),
  ];
  const calls = [];
  const result = calculateProjectBadges({}, sessions, projects, (item, candidates) => {
    calls.push(item);
    assert.strictEqual(candidates, projects);
    return resolveSession(item, candidates);
  });
  assert.deepEqual(calls, sessions);
  assert.deepEqual(result, {
    projectBadges: { other: { count: 2, level: "waiting" }, demo: { count: 2, level: "error" } },
    monitoredSessionsByProject: { other: [sessions[0], sessions[3]], demo: [sessions[1], sessions[4]] },
    attentionCount: 4,
  });
  assert.strictEqual(result.monitoredSessionsByProject.other[1], sessions[3]);
  assert.deepEqual(sessions.map((item) => item.id), [
    "other-first", "demo-first", "unmatched", "other-second", "demo-second",
  ]);
});

test("terminal and session badges combine and attention counts every contribution in a non-active project", () => {
  const terminals = record([
    terminal("active", "demo", { externalStatus: { level: "active" } }),
    terminal("waiting", "demo", { status: "waiting" }),
    terminal("active-other", "other", { externalStatus: { level: "active" } }),
  ]);
  const sessions = [session("done", "done"), session("active", "active")];
  assert.deepEqual(calculate(terminals, sessions), {
    projectBadges: { demo: { count: 4, level: "waiting" }, other: { count: 1, level: "active" } },
    monitoredSessionsByProject: { demo: sessions }, attentionCount: 4,
  });
  assert.equal(terminals.waiting.status, "waiting");
});

test("an error terminal keeps its severity when a lower-level session is added", () => {
  assert.deepEqual(
    calculate(record([terminal("error", "demo", { status: "error" })]), [session("done", "done")]).projectBadges,
    { demo: { count: 2, level: "error" } },
  );
});

test("unmatched sessions are skipped and terminal badges do not require an open project", () => {
  const result = calculateProjectBadges(
    record([terminal("closed", "closed", { status: "waiting" })]),
    [session("unmatched", "error")], [], () => null,
  );
  assert.deepEqual(result, {
    projectBadges: { closed: { count: 1, level: "waiting" } },
    monitoredSessionsByProject: {}, attentionCount: 1,
  });
});
