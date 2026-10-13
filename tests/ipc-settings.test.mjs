// Settings IPC (electron/ipc/settings-ipc.ts) against stand-ins, with AYA_HOME in a temp directory: presets and
// snippets are written there.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const HOME = mkdtempSync(join(tmpdir(), "aya-settings-ipc-"));
process.env.AYA_HOME = HOME;
const { registerSettingsIpc } = await import("../dist-electron/ipc/settings-ipc.js");

const CAMPBELL = JSON.stringify({
  name: "Campbell", foreground: "#CCCCCC", background: "#0C0C0C", cursorColor: "#FFFFFF",
  black: "#0C0C0C", red: "#C50F1F", green: "#13A10E", yellow: "#C19C00", blue: "#0037DA", purple: "#881798",
  cyan: "#3A96DD", white: "#CCCCCC", brightBlack: "#767676", brightRed: "#E74856", brightGreen: "#16C60C",
  brightYellow: "#F9F1A5", brightBlue: "#3B78FF", brightPurple: "#B4009E", brightCyan: "#61D6D6", brightWhite: "#F2F2F2",
});

function setup(over = {}) {
  const handlers = new Map();
  const calls = { dialog: [], saved: 0, intelligence: [] };
  registerSettingsIpc({
    ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
    senderWindow: (e) => e.win ?? null,
    dialog: { showOpenDialog: async (...args) => (calls.dialog.push(args), { canceled: true, filePaths: [] }) },
    home: () => "/home/test",
    presetsSaved: async () => void calls.saved++,
    intelligence: {
      summarize: async (req) => (calls.intelligence.push(["summarize", req]), "summary"),
      ollamaStatus: async (model) => (calls.intelligence.push(["status", model]), "status"),
      pullOllamaModel: async (model) => (calls.intelligence.push(["pull", model]), "pulled"),
    },
    ...over,
  });
  const call = (channel, e = {}, ...args) => handlers.get(channel)(e, ...args);
  return { handlers, call, calls };
}

test.after(() => rmSync(HOME, { recursive: true, force: true }));

test("registers exactly the settings channels", () => {
  assert.deepEqual([...setup().handlers.keys()].sort(), [
    "intelligence:ollama-status",
    "intelligence:pull-ollama-model",
    "local-summary:summarize",
    "omarchy:read",
    "omarchy:status",
    "presets:list",
    "presets:save",
    "presets:scan-harnesses",
    "sessions:list-monitored",
    "snippets:list",
    "snippets:save",
    "themes:import",
    "themes:list",
    "themes:save",
  ]);
});

test("saving presets writes them, then lets the brief follow; an invalid list is refused before either", async () => {
  const { call, calls } = setup();
  const preset = { id: "shell", name: "Shell", icon: ">", color: "#888888", command: "$SHELL" };
  await call("presets:save", {}, [preset]);
  assert.equal(calls.saved, 1);
  assert.equal((await call("presets:list")).some((p) => p.id === "shell" && p.command === "$SHELL"), true);
  await assert.rejects(call("presets:save", {}, "not a list"));
  assert.equal(calls.saved, 1);
});

test("importing a theme: the picker opens on the asking window from home, and a file becomes a theme", async (t) => {
  const file = join(HOME, "Campbell.json");
  writeFileSync(file, CAMPBELL);
  const win = { id: 3 };
  const { call, calls } = setup({
    dialog: { showOpenDialog: async (...args) => (calls.dialog.push(args), { canceled: false, filePaths: [file] }) },
  });
  const theme = await call("themes:import", { win });
  assert.equal(theme.name, "Campbell");
  assert.equal(theme.colors.foreground, "#CCCCCC");
  assert.equal(calls.dialog[0][0], win);
  assert.equal(calls.dialog[0][1].defaultPath, "/home/test");
});

test("a cancelled theme picker answers null", async () => {
  assert.equal(await setup().call("themes:import", {}), null);
});

test("Aya Intelligence requests go to their deps; a blank model name means the recommended one", async () => {
  const { call, calls } = setup();
  assert.equal(await call("local-summary:summarize", {}, { kind: "terminal", lines: [] }), "summary");
  assert.equal(await call("intelligence:ollama-status", {}, "  qwen3:4b "), "status");
  await call("intelligence:ollama-status", {}, "   ");
  assert.equal(await call("intelligence:pull-ollama-model", {}, "qwen3:4b"), "pulled");
  assert.deepEqual(calls.intelligence, [
    ["summarize", { kind: "terminal", lines: [] }],
    ["status", "qwen3:4b"],
    ["status", undefined],
    ["pull", "qwen3:4b"],
  ]);
});
