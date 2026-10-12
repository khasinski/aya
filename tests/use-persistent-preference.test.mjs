// The usePersistentPreference hook itself (its codecs are pinned in
// persistent-preference.test.mjs): what it reads from localStorage on mount,
// the default when nothing or something malformed is stored, that the setter
// updates the value and writes the serialized string under the key, and that a
// throwing or missing localStorage never breaks the app. React is replaced by a
// minimal hook runtime (useState with a once-only initializer, useCallback with
// Object.is deps) and localStorage by a recorded in-memory store.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODULE = join(process.cwd(), "dist-test", "hooks", "usePersistentPreference.js");
const reactId = createRequire(MODULE).resolve("react");

/** Just enough of React for one hook: slots per call order, re-render on act. */
let rendering = null;
const fakeReact = {
  useState(init) {
    const h = rendering;
    const i = h.index++;
    if (!(i in h.slots)) {
      const slot = { value: typeof init === "function" ? init() : init };
      slot.set = (next) => {
        slot.value = typeof next === "function" ? next(slot.value) : next;
        h.dirty = true;
      };
      h.slots[i] = slot;
    }
    return [h.slots[i].value, h.slots[i].set];
  },
  useCallback(fn, deps) {
    const h = rendering;
    const i = h.index++;
    const prev = h.slots[i];
    if (prev && prev.deps.length === deps.length && prev.deps.every((d, j) => Object.is(d, deps[j]))) {
      return prev.fn;
    }
    h.slots[i] = { fn, deps };
    return fn;
  },
};
const savedReact = require.cache[reactId];
require.cache[reactId] = { id: reactId, filename: reactId, loaded: true, exports: fakeReact };
const { usePersistentPreference, boolPreference, enumPreference } = await import(MODULE);
if (savedReact) require.cache[reactId] = savedReact;
else delete require.cache[reactId];

/** Mounts the hook; `act` runs a setter call and re-renders like React's act. */
function renderHook(key, codec) {
  const h = { slots: [], index: 0, dirty: false };
  const props = { key, codec };
  const hook = {
    value: undefined,
    set: undefined,
    render() {
      h.index = 0;
      rendering = h;
      try {
        [hook.value, hook.set] = usePersistentPreference(props.key, props.codec);
      } finally {
        rendering = null;
      }
    },
    rerender(next) {
      Object.assign(props, next);
      hook.render();
    },
    act(fn) {
      fn();
      if (h.dirty) {
        h.dirty = false;
        hook.render();
      }
    },
  };
  hook.render();
  return hook;
}

/** localStorage as the module sees it: a Map that records every call. */
function fakeStorage(t, initial = {}, { getItem, setItem } = {}) {
  const store = new Map(Object.entries(initial));
  const calls = [];
  const storage = {
    getItem: getItem ?? ((k) => (calls.push(["get", k]), store.has(k) ? store.get(k) : null)),
    setItem: setItem ?? ((k, v) => (calls.push(["set", k, v]), store.set(k, String(v)))),
  };
  installStorage(t, storage);
  return { store, calls };
}
function installStorage(t, storage) {
  const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  if (storage === undefined) delete globalThis.localStorage;
  else Object.defineProperty(globalThis, "localStorage", { value: storage, configurable: true, writable: true });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, "localStorage", saved);
    else delete globalThis.localStorage;
  });
}

const LAYOUT = enumPreference(["classic", "projects-left"], "classic");
const OFF = boolPreference(false);
const ON = boolPreference(true);
const JSON_MAP = {
  fallback: {},
  parse: (raw) => JSON.parse(raw),
  serialize: (v) => JSON.stringify(v),
};

test("nothing stored: the codec's fallback, read from the key, and nothing is written", (t) => {
  const { calls } = fakeStorage(t);
  assert.equal(renderHook("aya.layout", LAYOUT).value, "classic");
  assert.equal(renderHook("aya.sounds", ON).value, true);
  assert.equal(renderHook("aya.github", OFF).value, false);
  assert.deepEqual(calls, [["get", "aya.layout"], ["get", "aya.sounds"], ["get", "aya.github"]]);
  const parsed = [];
  const spy = { ...JSON_MAP, parse: (raw) => (parsed.push(raw), JSON_MAP.parse(raw)) };
  assert.equal(renderHook("aya.overrides", spy).value, JSON_MAP.fallback);
  assert.deepEqual(parsed, [], "parse only ever sees a present value");
});

test("a stored value is read through the codec's parse", (t) => {
  fakeStorage(t, { "aya.layout": "projects-left", "aya.sounds": "0", "aya.github": "1" });
  assert.equal(renderHook("aya.layout", LAYOUT).value, "projects-left");
  assert.equal(renderHook("aya.sounds", ON).value, false);
  assert.equal(renderHook("aya.github", OFF).value, true);
});

test("a malformed stored value reads as the default, and a parse that throws too", (t) => {
  fakeStorage(t, { "aya.layout": "bogus", "aya.overrides": "{not json" });
  assert.equal(renderHook("aya.layout", LAYOUT).value, "classic");
  const overrides = renderHook("aya.overrides", JSON_MAP);
  assert.equal(overrides.value, JSON_MAP.fallback, "the codec's own fallback, not a crash");
});

test("storage is read once on mount, not on every render", (t) => {
  const { store, calls } = fakeStorage(t, { "aya.layout": "projects-left" });
  const hook = renderHook("aya.layout", LAYOUT);
  store.set("aya.layout", "classic");
  hook.rerender();
  hook.rerender();
  assert.equal(hook.value, "projects-left");
  assert.equal(calls.filter(([op]) => op === "get").length, 1);
});

test("the setter updates the value and writes the serialized string under the key", (t) => {
  const { store, calls } = fakeStorage(t);
  const github = renderHook("aya.github", OFF);
  github.act(() => github.set(true));
  assert.equal(github.value, true);
  assert.equal(store.get("aya.github"), "1");
  github.act(() => github.set(false));
  assert.equal(github.value, false);
  assert.equal(store.get("aya.github"), "0");

  const overrides = renderHook("aya.overrides", JSON_MAP);
  overrides.act(() => overrides.set({ claude: false }));
  assert.deepEqual(overrides.value, { claude: false });
  assert.equal(store.get("aya.overrides"), '{"claude":false}');
  assert.deepEqual(calls.filter(([op]) => op === "set"), [
    ["set", "aya.github", "1"],
    ["set", "aya.github", "0"],
    ["set", "aya.overrides", '{"claude":false}'],
  ]);
});

test("a value set before is what the next mount reads", (t) => {
  fakeStorage(t);
  const first = renderHook("aya.layout", LAYOUT);
  first.act(() => first.set("projects-left"));
  assert.equal(renderHook("aya.layout", LAYOUT).value, "projects-left");
});

test("getItem throwing reads as the default", (t) => {
  fakeStorage(t, {}, {
    getItem: () => {
      throw new Error("SecurityError: access denied");
    },
  });
  assert.equal(renderHook("aya.sounds", ON).value, true);
  assert.equal(renderHook("aya.layout", LAYOUT).value, "classic");
});

test("setItem throwing: the setter does not throw and the value still changes", (t) => {
  let tried = 0;
  fakeStorage(t, {}, {
    setItem: () => {
      tried++;
      throw new Error("QuotaExceededError");
    },
  });
  const layout = renderHook("aya.layout", LAYOUT);
  layout.act(() => layout.set("projects-left"));
  assert.equal(tried, 1);
  assert.equal(layout.value, "projects-left");
});

test("a serialize that throws is swallowed the same way", (t) => {
  const { store } = fakeStorage(t);
  const codec = { ...JSON_MAP, serialize: () => { throw new TypeError("cyclic"); } };
  const hook = renderHook("aya.overrides", codec);
  hook.act(() => hook.set({ a: true }));
  assert.deepEqual(hook.value, { a: true });
  assert.equal(store.has("aya.overrides"), false);
});

test("no localStorage at all: the default on mount and a working in-memory setter", (t) => {
  installStorage(t, undefined);
  assert.equal(typeof globalThis.localStorage, "undefined");
  const github = renderHook("aya.github", OFF);
  assert.equal(github.value, false);
  github.act(() => github.set(true));
  assert.equal(github.value, true);
});

test("the setter is stable across renders while key and codec stay the same", (t) => {
  fakeStorage(t);
  const hook = renderHook("aya.layout", LAYOUT);
  const first = hook.set;
  hook.rerender();
  hook.act(() => hook.set("projects-left"));
  assert.equal(hook.set, first);
});

test("a new key or codec gives a new setter that writes with them", (t) => {
  const { store } = fakeStorage(t);
  const hook = renderHook("aya.sounds", ON);
  const first = hook.set;
  hook.rerender({ key: "aya.github" });
  assert.notEqual(hook.set, first);
  hook.act(() => hook.set(true));
  assert.equal(store.get("aya.github"), "1");
  assert.equal(store.has("aya.sounds"), false);

  const second = hook.set;
  const yesNo = { fallback: false, parse: (raw) => raw === "yes", serialize: (v) => (v ? "yes" : "no") };
  hook.rerender({ codec: yesNo });
  assert.notEqual(hook.set, second);
  hook.act(() => hook.set(false));
  assert.equal(store.get("aya.github"), "no");
});
