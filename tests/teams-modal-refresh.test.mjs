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
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function summary(roleIds, assignments = {}, name = "ux-review") {
  const definition = { name, roles: roleIds.map((id) => ({ id })), lead: roleIds[0] };
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
    liveness: { status: "never started" },
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

function mount(teamList, teamSave, tabs = [], project = { slug: "game", name: "Game", directory: "/project" }) {
  const state = { index: 0, slots: [], pendingEffects: [], tree: null };
  const intervals = [];
  let currentProject = project;
  const originalWindow = globalThis.window;
  globalThis.window = {
    setInterval: (callback) => { intervals.push(callback); return intervals.length - 1; },
    clearInterval: () => {},
    aya: { teamList, teamSave, teamPresets: async () => [] },
  };
  const render = () => {
    state.index = 0;
    rendering = state;
    try {
      state.tree = TeamsModal({
        project: { ...currentProject, tabs },
        intelligence: {},
        waiting: {},
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

test("removing a team during a poll starts a fresh refresh without another tick", async () => {
  const stalePoll = deferred();
  const removalRefresh = deferred();
  let calls = 0;
  const hook = mount(
    () => {
      calls++;
      if (calls === 1) return Promise.resolve([summary(["tester", "implementer"])]);
      if (calls === 2) return stalePoll.promise;
      return removalRefresh.promise;
    },
    async () => {},
  );
  try {
    await settle(hook);
    hook.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const card = findTeamCard(hook.render());
    const removal = card.props.onChanged();
    assert.equal(calls, 3, "the removal action starts a new request immediately");
    stalePoll.resolve([summary(["tester", "implementer"])]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls, 3, "the requested trailing refresh starts as soon as the old poll settles");
    removalRefresh.resolve([]);
    await removal;
    await settle(hook);
    assert.equal(findTeamCard(hook.render()), null, "the removed team disappears without waiting for the next interval");
  } finally {
    stalePoll.resolve([summary(["tester", "implementer"])]);
    removalRefresh.resolve([]);
    hook.cleanup();
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
    hook.render(); // Let the stale accepted response run the focus effect before the trailing result.
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
