// Exercise useTeams' async refresh/event behavior with a tiny React hook runtime.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODULE = join(process.cwd(), "dist-test", "hooks", "useTeams.js");
const reactId = createRequire(MODULE).resolve("react");

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
require.cache[reactId] = { id: reactId, filename: reactId, loaded: true, exports: fakeReact };
const { useTeams } = await import(MODULE);
if (savedReact) require.cache[reactId] = savedReact;
else delete require.cache[reactId];

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function settle(hook) {
  await new Promise((resolve) => setImmediate(resolve));
  hook.render();
}

function summary(role) {
  return {
    name: "ux-review",
    definition: { name: "ux-review", roles: [{ id: role }], lead: role },
    repoDefinition: null,
    error: null,
    repoChanged: false,
    unsaved: false,
    repoGone: false,
    agentAuthored: false,
    paused: false,
    running: false,
    assignments: {},
    unread: {},
    log: [],
  };
}

function mount(teamList, projects = [{ slug: "game", directory: "/project" }], activeProjectId = "game", teamAssign = async () => {}) {
  const state = { index: 0, slots: [], pendingEffects: [], result: null };
  const intervals = [];
  let currentProjects = projects;
  const originalWindow = globalThis.window;
  globalThis.window = {
    setInterval: (callback) => { intervals.push(callback); return intervals.length - 1; },
    clearInterval: () => {},
    aya: {
      teamList,
      teamAssign,
    },
  };
  const render = () => {
    state.index = 0;
    rendering = state;
    try { state.result = useTeams({ projects: currentProjects, activeProjectId, activeProjectRemote: false }); }
    finally { rendering = null; }
    const effects = state.pendingEffects.splice(0);
    for (const effect of effects) effect();
    return state.result;
  };
  render();
  return {
    render,
    updateProjects: (next) => { currentProjects = next; return render(); },
    closeTeams: () => state.result.onTeamsWindowClosed("game"),
    tickInterval: (index = 0) => intervals[index]?.(),
    cleanup: () => { globalThis.window = originalWindow; },
  };
}

test("a pre-save team-list response cannot overwrite the post-save definition", async () => {
  const beforeSave = deferred();
  const afterSave = deferred();
  let calls = 0;
  const hook = mount(() => (calls++ === 0 ? beforeSave.promise : afterSave.promise));
  try {
    hook.closeTeams();
    afterSave.resolve([summary("fresh")]);
    await settle(hook);
    beforeSave.resolve([summary("stale")]);
    await settle(hook);
    assert.equal(hook.render().teamsByProject.game[0].definition.roles[0].id, "fresh");
  } finally { hook.cleanup(); }
});

test("a project added during an in-flight poll is loaded without another interval tick", async () => {
  const firstGameList = deferred();
  const calls = [];
  const hook = mount((slug) => {
    calls.push(slug);
    if (calls.length === 1) return firstGameList.promise;
    return Promise.resolve([summary(slug)]);
  });
  try {
    hook.updateProjects([
      { slug: "game", directory: "/project" },
      { slug: "added", directory: "/added" },
    ]);
    assert.deepEqual(calls, ["game", "game", "added"], "the project-list change starts a current-scope batch immediately");
    firstGameList.resolve([summary("game-initial")]);
    await settle(hook);
    assert.deepEqual(calls, ["game", "game", "added"]);
    assert.equal(hook.render().teamsByProject.added[0].definition.roles[0].id, "added");
  } finally { hook.cleanup(); }
});

test("an assignment started before the project list changed refreshes the still-current scope", async () => {
  const assignment = deferred();
  const currentGame = deferred();
  const addedProject = deferred();
  const calls = [];
  const hook = mount(
    (slug) => {
      calls.push(slug);
      if (calls.length === 1) return Promise.resolve([summary("initial")]);
      if (calls.length === 2) return currentGame.promise;
      if (calls.length === 3) return addedProject.promise;
      return Promise.resolve([summary(`late-${slug}`)]);
    },
    [{ slug: "game", directory: "/project" }],
    "game",
    () => assignment.promise,
  );
  try {
    await settle(hook);
    hook.render().onAssignTeamRole("ux-review", "reviewer", "pane-1");
    await new Promise((resolve) => setImmediate(resolve));
    hook.updateProjects([
      { slug: "game", directory: "/project" },
      { slug: "added", directory: "/added" },
    ]);
    assert.deepEqual(calls, ["game", "game", "added"]);
    assignment.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["game", "game", "added", "game", "added"]);
    currentGame.resolve([summary("current-game")]);
    addedProject.resolve([summary("added-project")]);
    await settle(hook);
    await settle(hook);
    assert.equal(hook.render().teamsByProject.added?.[0]?.definition.roles[0].id, "late-added");
  } finally {
    assignment.resolve();
    currentGame.resolve([summary("current-game")]);
    addedProject.resolve([summary("added-project")]);
    hook.cleanup();
  }
});

test("an assignment that completes after a project is added refreshes the current scope", async () => {
  const assignment = deferred();
  const currentRead = deferred();
  const calls = [];
  const hook = mount(
    (slug) => {
      calls.push(slug);
      if (calls.length === 1) return Promise.resolve([summary("initial")]);
      if (calls.length === 2) return Promise.resolve([summary("current-game")]);
      if (calls.length === 3) return Promise.resolve([summary("added-project")]);
      if (calls.length === 4) return currentRead.promise;
      return Promise.resolve([summary(`refresh-${slug}`)]);
    },
    [{ slug: "game", directory: "/project" }],
    "game",
    () => assignment.promise,
  );
  try {
    await settle(hook);
    hook.render().onAssignTeamRole("ux-review", "reviewer", "pane-1");
    await new Promise((resolve) => setImmediate(resolve));
    hook.updateProjects([
      { slug: "game", directory: "/project" },
      { slug: "added", directory: "/added" },
    ]);
    assert.deepEqual(calls, ["game", "game", "added"]);
    assignment.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls, ["game", "game", "added", "game", "added"], "completion refreshes the still-open project set");
    currentRead.resolve([summary("assigned-current")]);
    await settle(hook);
    assert.equal(hook.render().teamsByProject.game[0].definition.roles[0].id, "assigned-current");
  } finally {
    assignment.resolve();
    currentRead.resolve([summary("assigned-current")]);
    hook.cleanup();
  }
});

test("an assignment during a poll starts a fresh chip refresh without another tick", async () => {
  const poll = deferred();
  const fresh = deferred();
  let listCalls = 0;
  let assignmentCalls = 0;
  const hook = mount(
    () => {
      listCalls++;
      if (listCalls === 1) return Promise.resolve([summary("initial")]);
      if (listCalls === 2) return poll.promise;
      return fresh.promise;
    },
    undefined,
    undefined,
    async () => { assignmentCalls++; },
  );
  try {
    await settle(hook);
    hook.tickInterval();
    await new Promise((resolve) => setImmediate(resolve));
    hook.render().onAssignTeamRole("ux-review", "reviewer", "pane-1");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(assignmentCalls, 1);
    assert.equal(listCalls, 3, "assignment completion immediately launches its own refresh");
    fresh.resolve([summary("assigned")]);
    await settle(hook);
    poll.resolve([summary("stale")]);
    await settle(hook);
    assert.equal(hook.render().activeTeams[0].definition.roles[0].id, "assigned");
  } finally {
    poll.resolve([summary("stale")]);
    fresh.resolve([summary("assigned")]);
    await new Promise((resolve) => setImmediate(resolve));
    hook.cleanup();
  }
});

test("a slow project list does not let interval polls supersede it or starve fast projects", async () => {
  const slowResult = deferred();
  let slowCalls = 0;
  let fastCalls = 0;
  const hook = mount(
    (slug) => {
      if (slug === "slow") { slowCalls++; return slowResult.promise; }
      fastCalls++;
      return Promise.resolve([summary(`fast-${fastCalls}`)]);
    },
    [{ slug: "slow", directory: "/slow" }, { slug: "fast", directory: "/fast" }],
    "fast",
  );
  try {
    hook.tickInterval();
    await settle(hook);
    assert.equal(slowCalls, 1, "a timer tick must not start another batch while the first is pending");
    assert.equal(fastCalls, 1);
    slowResult.resolve([summary("slow")]);
    await settle(hook);
    assert.equal(hook.render().activeTeams[0].definition.roles[0].id, "fast-1");
  } finally { hook.cleanup(); }
});
