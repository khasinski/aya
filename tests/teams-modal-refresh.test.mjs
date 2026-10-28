// Exercise TeamsModal's list refresh ordering without mounting the terminal UI.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODULE = join(process.cwd(), "dist-test", "components", "TeamsModal.js");
const reactId = createRequire(MODULE).resolve("react");
const jsxRuntimeId = createRequire(MODULE).resolve("react/jsx-runtime");

let rendering = null;
const fakeReact = {
  useState(initial) {
    const h = rendering;
    const index = h.index++;
    if (!h.slots[index]) {
      const slot = { value: typeof initial === "function" ? initial() : initial };
      slot.set = (next) => { slot.value = typeof next === "function" ? next(slot.value) : next; };
      h.slots[index] = slot;
    }
    const slot = h.slots[index];
    return [slot.value, slot.set];
  },
  useCallback(fn, deps) {
    const h = rendering;
    const index = h.index++;
    const previous = h.slots[index];
    if (previous && previous.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return previous.fn;
    h.slots[index] = { fn, deps };
    return fn;
  },
  useMemo(factory, deps) {
    const h = rendering;
    const index = h.index++;
    const previous = h.slots[index];
    if (previous && previous.deps.length === deps.length && previous.deps.every((value, i) => Object.is(value, deps[i]))) return previous.value;
    const value = factory();
    h.slots[index] = { value, deps };
    return value;
  },
  useRef(initial) {
    const h = rendering;
    const index = h.index++;
    return h.slots[index] ??= { current: initial };
  },
  useEffect(effect, deps) {
    const h = rendering;
    const index = h.index++;
    const previous = h.slots[index];
    if (!previous || previous.deps.length !== deps.length || !previous.deps.every((value, i) => Object.is(value, deps[i]))) {
      h.pendingEffects.push(() => {
        previous?.cleanup?.();
        const cleanup = effect();
        h.slots[index] = { deps, cleanup };
      });
    }
  },
};

const savedReact = require.cache[reactId];
const savedJsxRuntime = require.cache[jsxRuntimeId];
require.cache[reactId] = { id: reactId, filename: reactId, loaded: true, exports: fakeReact };
require.cache[jsxRuntimeId] = {
  id: jsxRuntimeId,
  filename: jsxRuntimeId,
  loaded: true,
  exports: {
    Fragment: Symbol.for("react.fragment"),
    jsx: (type, props) => ({ type, props }),
    jsxs: (type, props) => ({ type, props }),
  },
};
const { TeamsModal } = await import(MODULE);
if (savedReact) require.cache[reactId] = savedReact;
else delete require.cache[reactId];
if (savedJsxRuntime) require.cache[jsxRuntimeId] = savedJsxRuntime;
else delete require.cache[jsxRuntimeId];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function summary(roleIds, assignments = {}, name = "ux-review") {
  const definition = { name, roles: roleIds.map((id) => ({ id, sendsTo: [], mustNot: "skip no rounds" })), lead: roleIds[0] };
  return {
    name,
    definition,
    repoDefinition: null,
    error: null,
    repoChanged: false,
    repoGone: false,
    unsaved: false,
    paused: false,
    running: false,
    agentAuthored: false,
    assignments,
    paneHolds: {},
    paneNotes: {},
    roleNotes: {},
    restartable: [],
    staleNotes: [],
    olderRoles: {},
    unread: {},
    unsent: [],
    liveness: { status: "never started", blocked: [], unreached: null, stalledSince: null },
    log: [],
  };
}

function findTeamCard(node, name = "ux-review") {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTeamCard(child, name);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.props?.team?.name === name) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findTeamCard(child, name);
    if (found) return found;
  }
  return null;
}

function findEditor(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findEditor(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.props?.initial?.name === "ux-review" && node.props?.onSave) return node;
  const children = node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findEditor(child);
    if (found) return found;
  }
  return null;
}

function findNode(node, predicate) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, predicate);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (predicate(node)) return node;
  return findNode(node.props?.children, predicate);
}

function renderComponent(element) {
  const state = { index: 0, slots: [], pendingEffects: [] };
  rendering = state;
  let tree;
  try { tree = element.type(element.props); }
  finally { rendering = null; }
  for (const effect of state.pendingEffects.splice(0)) effect();
  return tree;
}

function findButton(node, label) {
  return findNode(node, (element) => element.type === "button" && element.props.children === label);
}

function findTeamsBody(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findTeamsBody(child);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  if (node.props?.className === "aya-teams-body" && node.props.ref) return node.props.ref;
  return findTeamsBody(node.props?.children);
}

function mount(teamList, teamSave, tabs = [], project = { slug: "game", name: "Game", directory: "/project" }, terminals = {}, api = {}) {
  const state = { index: 0, slots: [], pendingEffects: [], tree: null };
  const intervals = [];
  let currentProject = project;
  const originalWindow = globalThis.window;
  globalThis.window = {
    setInterval: (callback) => { intervals.push(callback); return intervals.length - 1; },
    clearInterval: () => {},
    aya: { teamList, teamSave, teamPresets: async () => [], ...api },
  };
  const render = () => {
    state.index = 0;
    rendering = state;
    try {
      state.tree = TeamsModal({
        project: { ...currentProject, tabs },
        intelligence: {},
        waiting: {},
        terminals,
        onClose: () => {},
      });
    } finally { rendering = null; }
    const effects = state.pendingEffects.splice(0);
    for (const effect of effects) effect();
    return state.tree;
  };
  render();
  return {
    render,
    updateProject: (next) => { currentProject = next; return render(); },
    updateTerminals: (next) => { terminals = next; return render(); },
    tick: () => intervals[0]?.(),
    cleanup: () => { globalThis.window = originalWindow; },
  };
}

async function settle(hook) {
  await new Promise((resolve) => setImmediate(resolve));
  hook.render();
}

test("a pre-save periodic reload cannot replace the post-save team card", async () => {
  const stale = deferred();
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([summary(["tester", "implementer"])]);
      if (calls === 2) return stale.promise;
      return Promise.resolve([summary(["tester", "implementer", "auditor"])]);
    },
    async () => {},
  );
  try {
    await settle(hook);
    hook.tick(); // A TeamsModal poll starts before the save.
    const card = findTeamCard(hook.render());
    assert.ok(card, "the existing team card is loaded");
    card.props.onEdit(card.props.team.definition);
    const editor = findEditor(hook.render());
    assert.ok(editor, "the editor opened");
    const updated = { ...editor.props.initial, roles: [...editor.props.initial.roles, { id: "auditor" }] };
    const saving = editor.props.onSave(updated);
    await new Promise((resolve) => setImmediate(resolve));
    stale.resolve([summary(["tester", "implementer"])]);
    await saving;
    await settle(hook);
    assert.ok(findTeamCard(hook.render()).props.team.definition.roles.some((role) => role.id === "auditor"));

    await settle(hook);
    assert.ok(findTeamCard(hook.render()).props.team.definition.roles.some((role) => role.id === "auditor"));
  } finally { hook.cleanup(); }
});

test("an action from the old project cannot invalidate the current project's poll", async () => {
  const oldAction = deferred();
  const projectB = deferred();
  const calls = [];
  const hook = mount(
    (slug) => {
      calls.push(slug);
      if (slug === "a" && calls.filter((item) => item === "a").length === 1) return Promise.resolve([summary(["role"], {}, "team-a")]);
      if (slug === "a") return oldAction.promise;
      return projectB.promise;
    },
    async () => {},
    [],
    { slug: "a", name: "Project A", directory: "/a" },
  );
  try {
    await settle(hook);
    const oldRefresh = findTeamCard(hook.render(), "team-a").props.onChanged;
    hook.updateProject({ slug: "b", name: "Project B", directory: "/b" });
    const lateActionRefresh = oldRefresh();
    await new Promise((resolve) => setImmediate(resolve));
    oldAction.resolve([summary(["role"], {}, "team-a")]);
    projectB.resolve([summary(["role"], {}, "team-b")]);
    await lateActionRefresh;
    await settle(hook);
    assert.ok(findTeamCard(hook.render(), "team-b"), "B's response remains the current generation");
  } finally {
    oldAction.resolve([summary(["role"], {}, "team-a")]);
    projectB.resolve([summary(["role"], {}, "team-b")]);
    hook.cleanup();
  }
});

test("an old project's list failure does not show beside the current project's cards", async () => {
  let aCalls = 0;
  const oldFailure = deferred();
  const hook = mount(
    (slug) => {
      if (slug === "a") {
        if (aCalls++ === 0) return Promise.resolve([summary(["role"], {}, "team-a")]);
        return oldFailure.promise;
      }
      return Promise.resolve([summary(["role"], {}, "team-b")]);
    },
    async () => {},
    [],
    { slug: "a", name: "Project A", directory: "/a" },
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(aCalls, 2, "A's refresh is already in flight before switching");
    hook.updateProject({ slug: "b", name: "Project B", directory: "/b" });
    await settle(hook);
    oldFailure.reject(new Error("old project failed"));
    await settle(hook);
    const error = findNode(hook.render(), (node) => node.type?.name === "ErrorLine");
    assert.equal(error?.props.error ?? null, null, "the stale failure is not shown for project B");
    assert.ok(findTeamCard(hook.render(), "team-b"));
  } finally { oldFailure.reject(new Error("cleanup")); hook.cleanup(); }
});

test("a stale failure from an earlier request cannot appear after the newer same-project response", async () => {
  const oldFailure = deferred();
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([summary(["role"], {}, "team-a")]);
      if (calls === 2) return oldFailure.promise;
      return Promise.resolve([summary(["role"], {}, "team-a")]);
    },
    async () => {},
    [],
    { slug: "a", name: "Project A", directory: "/a" },
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 2, "the old request is pending");
    await findTeamCard(hook.render(), "team-a").props.onChanged();
    await settle(hook);
    oldFailure.reject(new Error("stale request failure"));
    await settle(hook);
    const error = findNode(hook.render(), (node) => node.type?.name === "ErrorLine");
    assert.equal(error?.props.error ?? null, null, "an older failed request cannot replace the current success");
  } finally { oldFailure.reject(new Error("cleanup")); hook.cleanup(); }
});

test("two interval ticks do not start more window polls while teamList is pending", async () => {
  const slow = deferred();
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      return calls === 1 ? Promise.resolve([summary(["tester", "implementer"])]) : slow.promise;
    },
    async () => {},
  );
  try {
    await settle(hook);
    hook.tick();
    hook.tick();
    assert.equal(calls, 2, "the second interval does not overlap the first outstanding poll");
  } finally {
    slow.resolve([summary(["tester", "implementer"])]);
    hook.cleanup();
  }
});

test("the real Remove team action refreshes during a poll without waiting for another tick", async () => {
  const stalePoll = deferred();
  const removalRefresh = deferred();
  let calls = 0;
  const repoGone = summary(["tester", "implementer"]);
  repoGone.repoGone = true;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([repoGone]);
      if (calls === 2) return stalePoll.promise;
      return removalRefresh.promise;
    },
    async () => {},
    [],
    undefined,
    {},
    { teamRemove: async () => {} },
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const card = renderComponent(findTeamCard(hook.render()));
    const remove = findButton(card, "Remove team");
    assert.ok(remove, "the real remove action is rendered");
    const removal = remove.props.onClick();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "the removal action starts a new request immediately");
    stalePoll.resolve([repoGone]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "the requested trailing refresh starts as soon as the old poll settles");
    removalRefresh.resolve([]);
    await removal;
    await settle(hook);
    assert.equal(findTeamCard(hook.render()), null, "the removed team disappears without waiting for the next interval");
  } finally {
    stalePoll.resolve([repoGone]);
    removalRefresh.resolve([]);
    hook.cleanup();
  }
});

test("the real Pause and Resume card actions each refresh immediately with interval polling off", async () => {
  for (const action of [
    { name: "Pause", configure: (value) => { value.running = true; }, api: "teamPause", result: { paused: true, running: false } },
    { name: "Resume", configure: (value) => { value.paused = true; }, api: "teamResume", result: { paused: false, running: true } },
  ]) {
    let calls = 0;
    const apiCalls = [];
    const initial = summary(["tester", "implementer"]);
    action.configure(initial);
    const updated = { ...initial, ...action.result };
    const hook = mount(
      async () => { calls++; return [calls === 1 ? initial : updated]; },
      async () => {},
      [],
      undefined,
      {},
      { [action.api]: async (...args) => { apiCalls.push(args); } },
    );
    try {
      await settle(hook);
      const button = findButton(renderComponent(findTeamCard(hook.render())), action.name);
      assert.ok(button, `${action.name} is a real card action`);
      await button.props.onClick();
      assert.deepEqual(apiCalls, [["game", "ux-review"]], `${action.name} invokes ${action.api} for this project and team`);
      assert.equal(calls, 2, `${action.name} refreshes without an interval tick`);
      const refreshed = findTeamCard(hook.render()).props.team;
      assert.equal(refreshed.paused, action.result.paused, `${action.name} renders the refreshed paused state`);
      assert.equal(refreshed.running, action.result.running, `${action.name} renders the refreshed running state`);
    } finally { hook.cleanup(); }
  }
});

test("switching projects during a poll never renders the old project's teams", async () => {
  const oldPoll = deferred();
  const projectB = deferred();
  const calls = [];
  const hook = mount(
    (slug) => {
      calls.push(slug);
      if (slug === "a" && calls.filter((item) => item === "a").length === 1) return Promise.resolve([summary(["role"], {}, "team-a")]);
      if (slug === "a") return oldPoll.promise;
      return projectB.promise;
    },
    async () => {},
    [],
    { slug: "a", name: "Project A", directory: "/a" },
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const tree = hook.updateProject({ slug: "b", name: "Project B", directory: "/b" });
    assert.equal(calls.filter((item) => item === "b").length, 1, "the project switch starts B's request immediately");
    assert.equal(findTeamCard(tree, "team-a"), null, "A's cards are not rendered under B's title while B loads");
    projectB.resolve([summary(["role"], {}, "team-b")]);
    await settle(hook);
    assert.ok(findTeamCard(hook.render(), "team-b"));
    oldPoll.resolve([summary(["role"], {}, "team-a")]);
    await settle(hook);
    assert.ok(findTeamCard(hook.render(), "team-b"));
    assert.equal(findTeamCard(hook.render(), "team-a"), null);
  } finally {
    oldPoll.resolve([summary(["role"], {}, "team-a")]);
    projectB.resolve([summary(["role"], {}, "team-b")]);
    hook.cleanup();
  }
});

test("each team action starts a fresh request during a poll, while interval ticks do not", async () => {
  const poll = deferred();
  const actionResponses = [deferred(), deferred()];
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([summary(["tester"])]);
      if (calls === 2) return poll.promise;
      return actionResponses[calls - 3].promise;
    },
    async () => {},
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const card = findTeamCard(hook.render());
    const firstAction = card.props.onChanged();
    const secondAction = card.props.onChanged();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 4, "each action starts its own new request immediately");
    hook.tick();
    hook.tick();
    assert.equal(calls, 4, "interval ticks do not stack on action requests");
    poll.resolve([summary(["tester"])]);
    actionResponses[0].resolve([summary(["tester"])]);
    actionResponses[1].resolve([summary(["tester"])]);
    await Promise.all([firstAction, secondAction]);
  } finally {
    poll.resolve([summary(["tester"])]);
    for (const response of actionResponses) response.resolve([summary(["tester"])]);
    hook.cleanup();
  }
});

test("the Pane selector is chosen from the refreshed team card after Save", async () => {
  const calls = [];
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const paneSelects = ["tester", "implementer"].map((role) => ({
    getAttribute: (name) => name === "aria-label" ? `Pane for ${role}` : null,
    focus() { globalThis.document.activeElement = this; },
  }));
  const card = {
    dataset: { testid: "team-ux-review" },
    scrollIntoView() {},
    querySelectorAll: () => paneSelects,
  };
  const body = { querySelectorAll: () => [card], querySelector: () => null, children: [], scrollTop: 0, clientHeight: 500 };
  const hook = mount(
    () => {
      calls.push("list");
      return Promise.resolve(calls.length === 1
        ? [summary(["tester", "implementer"], { implementer: "pane-2" })]
        : [summary(["tester", "implementer"], { tester: "pane-1" })]);
    },
    async () => {},
    [{ id: "pane-1" }, { id: "pane-2" }],
  );
  try {
    findTeamsBody(hook.render()).current = body;
    await settle(hook);
    const teamCard = findTeamCard(hook.render());
    teamCard.props.onEdit(teamCard.props.team.definition);
    const editor = findEditor(hook.render());
    await editor.props.onSave(editor.props.initial);
    await settle(hook);
    assert.equal(globalThis.document.activeElement, paneSelects[1], "the refreshed card's first unassigned role is implementer");
  } finally {
    hook.cleanup();
    globalThis.document = oldDocument;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("a pane with confirmed spawn failure is unassigned when Save returns focus", async () => {
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const paneSelects = ["tester", "implementer"].map((role) => ({
    getAttribute: (name) => name === "aria-label" ? `Pane for ${role}` : null,
    focus() { globalThis.document.activeElement = this; },
  }));
  const card = { dataset: { testid: "team-ux-review" }, scrollIntoView() {}, querySelectorAll: () => paneSelects };
  const body = { querySelectorAll: () => [card], querySelector: () => null, children: [], scrollTop: 0, clientHeight: 500 };
  const failedPane = {
    id: "failed-pane", projectSlug: "game", presetId: "claude", name: "shell 1", cwd: "/project", status: "error",
    bell: false, exitCode: null, stopped: false, spawnFailure: { reason: "spawn-failed", detail: "could not start" },
  };
  const hook = mount(
    async () => [summary(["tester", "implementer"], { tester: "failed-pane" })],
    async () => {},
    [{ id: "failed-pane", name: "shell 1" }],
    undefined,
    { "failed-pane": failedPane },
  );
  try {
    findTeamsBody(hook.render()).current = body;
    await settle(hook);
    findTeamCard(hook.render()).props.onEdit(findTeamCard(hook.render()).props.team.definition);
    await findEditor(hook.render()).props.onSave(findEditor(hook.render()).props.initial);
    await settle(hook);
    assert.equal(globalThis.document.activeElement, paneSelects[0], "the failed tester pane is treated as unassigned");
  } finally {
    hook.cleanup();
    globalThis.document = oldDocument;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("the Pane selector distinguishes live, exited, stopped and failed panes", async () => {
  const states = [
    { name: "live", state: { id: "pane", exitCode: null, stopped: false }, expected: "shell 1" },
    { name: "exited", state: { id: "pane", exitCode: 0, stopped: false }, expected: "shell 1 (exited)" },
    { name: "stopped", state: { id: "pane", exitCode: null, stopped: true }, expected: "shell 1 (stopped)" },
    { name: "failed to start", state: { id: "pane", exitCode: null, stopped: false, spawnFailure: { reason: "spawn-failed" } }, expected: "shell 1 (failed to start)" },
  ];
  for (const item of states) {
    const hook = mount(
      async () => [summary(["tester"], { tester: "pane" })],
      async () => {},
      [{ id: "pane", name: "shell 1" }],
      undefined,
      { pane: item.state },
    );
    try {
      await settle(hook);
      const card = renderComponent(findTeamCard(hook.render()));
      const select = findNode(card, (node) => node.type === "select" && node.props["aria-label"] === "Pane for tester");
      const option = findNode(select, (node) => node.type === "option" && node.props.value === "pane");
      assert.equal(Array.isArray(option?.props.children) ? option.props.children.join("") : option?.props.children, item.expected, item.name);
    } finally { hook.cleanup(); }
  }
});

test("a pre-save poll with the same roles cannot consume the post-save focus request", async () => {
  const oldPoll = deferred();
  const saveRefresh = deferred();
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const paneSelects = ["tester", "implementer", "auditor"].map((role) => ({
    getAttribute: (name) => name === "aria-label" ? `Pane for ${role}` : null,
    focus() { globalThis.document.activeElement = this; },
  }));
  const card = {
    dataset: { testid: "team-ux-review" },
    scrollIntoView() {},
    querySelectorAll: () => paneSelects,
  };
  const body = { querySelectorAll: () => [card], querySelector: () => null, children: [], scrollTop: 0, clientHeight: 500 };
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([summary(["tester", "implementer"], { tester: "pane-1", implementer: "pane-2" })]);
      if (calls === 2) return oldPoll.promise;
      return saveRefresh.promise;
    },
    async () => {},
    [{ id: "pane-1" }, { id: "pane-2" }],
  );
  try {
    findTeamsBody(hook.render()).current = body;
    await settle(hook);
    const teamCard = findTeamCard(hook.render());
    teamCard.props.onEdit(teamCard.props.team.definition);
    const editor = findEditor(hook.render());
    hook.tick(); // A poll is already outstanding when Save begins.
    await new Promise((resolve) => setImmediate(resolve));
    const saving = editor.props.onSave(editor.props.initial);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "the post-save request starts before the older poll resolves");
    // Same role IDs, but this stale read predates a reassignment in another window.
    oldPoll.resolve([summary(["tester", "implementer"], { implementer: "pane-2" })]);
    await new Promise((resolve) => setImmediate(resolve));
    hook.render();
    assert.equal(globalThis.document.activeElement, null, "the pre-save response cannot consume the focus request");
    saveRefresh.resolve([summary(["tester", "implementer"], { tester: "pane-1" })]);
    await saving;
    await settle(hook);
    assert.equal(globalThis.document.activeElement, paneSelects[1], "focus follows the first role unassigned in the post-save refresh");
    await settle(hook);
    assert.equal(globalThis.document.activeElement, paneSelects[1], "the post-save refresh corrects focus after the stale poll");
  } finally {
    oldPoll.resolve([summary(["tester", "implementer"], { implementer: "pane-2" })]);
    saveRefresh.resolve([summary(["tester", "implementer"], { tester: "pane-1" })]);
    hook.cleanup();
    globalThis.document = oldDocument;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("the focus request starts only after teamSave succeeds", async () => {
  const save = deferred();
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const pane = { getAttribute: (name) => name === "aria-label" ? "Pane for tester" : null, focus() { globalThis.document.activeElement = this; } };
  const card = { dataset: { testid: "team-ux-review" }, scrollIntoView() {}, querySelectorAll: () => [pane] };
  const body = { querySelectorAll: () => [card], querySelector: () => null, children: [], scrollTop: 0, clientHeight: 500 };
  let listCalls = 0;
  const hook = mount(
    async () => { listCalls++; return [summary(["tester"])]; },
    () => save.promise,
    [],
  );
  try {
    findTeamsBody(hook.render()).current = body;
    await settle(hook);
    const teamCard = findTeamCard(hook.render());
    teamCard.props.onEdit(teamCard.props.team.definition);
    const editor = findEditor(hook.render());
    const pendingSave = editor.props.onSave(editor.props.initial);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(listCalls, 1, "no focus-refresh starts before the save returns");
    assert.equal(globalThis.document.activeElement, null);
    save.resolve();
    await pendingSave;
    await settle(hook);
    assert.equal(listCalls, 2);
    assert.equal(globalThis.document.activeElement, pane);
  } finally {
    save.resolve();
    hook.cleanup();
    globalThis.document = oldDocument;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});

test("a pane that exits while teamSave is pending is considered unassigned for the returned focus", async () => {
  const save = deferred();
  const oldDocument = globalThis.document;
  const oldResizeObserver = globalThis.ResizeObserver;
  globalThis.document = { activeElement: null };
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  const paneSelects = ["tester", "implementer"].map((role) => ({
    getAttribute: (name) => name === "aria-label" ? `Pane for ${role}` : null,
    focus() { globalThis.document.activeElement = this; },
  }));
  const card = { dataset: { testid: "team-ux-review" }, scrollIntoView() {}, querySelectorAll: () => paneSelects };
  const body = { querySelectorAll: () => [card], querySelector: () => null, children: [], scrollTop: 0, clientHeight: 500 };
  const running = { id: "pane-1", exitCode: null, stopped: false };
  const hook = mount(
    async () => [summary(["tester", "implementer"], { tester: "pane-1", implementer: "pane-2" })],
    () => save.promise,
    [{ id: "pane-1" }, { id: "pane-2" }],
    undefined,
    { "pane-1": running, "pane-2": { id: "pane-2", exitCode: null, stopped: false } },
  );
  try {
    findTeamsBody(hook.render()).current = body;
    await settle(hook);
    const teamCard = findTeamCard(hook.render());
    teamCard.props.onEdit(teamCard.props.team.definition);
    const pendingSave = findEditor(hook.render()).props.onSave(findEditor(hook.render()).props.initial);
    await new Promise((resolve) => setImmediate(resolve));
    hook.updateTerminals({
      "pane-1": { id: "pane-1", exitCode: 0, stopped: true },
      "pane-2": { id: "pane-2", exitCode: null, stopped: false },
    });
    save.resolve();
    await pendingSave;
    await settle(hook);
    assert.equal(globalThis.document.activeElement, paneSelects[0], "the newly exited first pane is selected for reassignment");
  } finally {
    save.resolve();
    hook.cleanup();
    globalThis.document = oldDocument;
    globalThis.ResizeObserver = oldResizeObserver;
  }
});
