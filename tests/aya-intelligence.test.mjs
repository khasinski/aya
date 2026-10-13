// Aya Intelligence against stand-in processes and providers; no helper, home directory or network is used.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { constants as fsConstants } from "node:fs";
import { join } from "node:path";
import {
  appleHelperPath,
  normalizeAyaIntelligenceConfig,
  ollamaStatus,
  pullOllamaModel,
  summarizeLocal,
  summarizeWithApple,
  summaryFromChat,
  unavailableLocalSummary,
  validateLocalSummaryRequest,
  validateOllamaModelName,
} from "../dist-electron/aya-intelligence.js";
import { COMMAND_PROBE_TIMEOUT_MS } from "../dist-electron/constants.js";
import { APPLE_HELPER_STDOUT_MAX_BYTES, RECOMMENDED_OLLAMA_MODEL } from "../dist-electron/intelligence-chat.js";
import { LOCAL_SUMMARY_MAX_LINES, SUMMARY_TEXT_MAX_CHARS } from "../dist-electron/local-summary-errors.js";
import { summaryPrompt } from "../dist-electron/aya-intelligence.js";
import { registerSettingsIpc } from "../dist-electron/ipc/settings-ipc.js";

const empty = { available: true, useful: false, summary: "" };
const req = { kind: "terminal", lines: ["Building Aya"] };
const turn = () => new Promise((resolve) => setImmediate(resolve));

function setup(over = {}) {
  const log = [];
  const child = new EventEmitter();
  for (const name of ["stdin", "stdout", "stderr"]) {
    child[name] = new EventEmitter();
    child[name].setEncoding = (encoding) => log.push(["encoding", name, encoding]);
  }
  child.stdin.end = (text) => log.push(["stdin", text]);
  child.kill = (signal) => log.push(["kill", signal]);
  const deps = {
    findExecutableOnPath: (name) => (log.push(["find", name]), "/stand-in/ollama"),
    platform: () => "darwin",
    access: async (...args) => void log.push(["access", ...args]),
    spawn: (...args) => (log.push(["spawn", ...args]), child),
    fetch: async (...args) => (log.push(["fetch", ...args]), { ok: true, json: async () => ({ models: [] }) }),
    providerChat: async (...args) => (log.push(["chat", ...args]), { ok: true, content: '{"useful":true,"summary":"Building Aya"}' }),
    ...over,
  };
  return { deps, log, child };
}

async function appleReply(reply, code = 0) {
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  s.child.stdout.emit("data", typeof reply === "string" ? reply : JSON.stringify(reply));
  s.child.emit("close", code);
  return pending;
}

test("unavailable summaries keep the empty shape and normalize optional errors", () => {
  const unavailable = { available: false, useful: false, summary: "" };
  for (const error of [undefined, "", " \n "]) assert.deepEqual(unavailableLocalSummary(error), unavailable);
  assert.deepEqual(unavailableLocalSummary(" assetsUnavailable\n detail "), { ...unavailable, error: "apple-model-unavailable" });
  assert.equal(unavailableLocalSummary("x".repeat(200)).error, "x".repeat(SUMMARY_TEXT_MAX_CHARS));
});

test("config normalization rejects non-records and preserves defaults and trimmed provider settings", () => {
  for (const value of [null, undefined, [], "ollama", 7]) assert.equal(normalizeAyaIntelligenceConfig(value), undefined);
  const defaults = { provider: "apple", ollamaModel: RECOMMENDED_OLLAMA_MODEL, openAiBaseUrl: "", openAiApiKey: "", openAiModel: "" };
  assert.deepEqual(normalizeAyaIntelligenceConfig({}), defaults);
  assert.deepEqual(normalizeAyaIntelligenceConfig({ provider: "unknown", ollamaModel: " \n ", openAiApiKey: 9 }), defaults);
  for (const provider of ["apple", "ollama", "openai"]) {
    assert.deepEqual(normalizeAyaIntelligenceConfig({ provider, ollamaModel: " m:tag ", openAiBaseUrl: " http://fake/v1 ", openAiApiKey: " key ", openAiModel: " model " }), {
      provider, ollamaModel: "m:tag", openAiBaseUrl: "http://fake/v1", openAiApiKey: "key", openAiModel: "model",
    });
  }
});

test("summary validation rejects invalid requests and lines with the original messages", () => {
  for (const value of [null, undefined, [], "text", 3]) {
    assert.throws(() => validateLocalSummaryRequest(value), { message: "local-summary:summarize.req must be an object" });
  }
  for (const lines of [undefined, null, "text", {}]) {
    assert.throws(() => validateLocalSummaryRequest({ lines }), { message: "local-summary:summarize.lines must be an array" });
  }
});

test("summary validation filters before taking trailing lines and normalizes only a truthy config", () => {
  const lines = Array.from({ length: LOCAL_SUMMARY_MAX_LINES + 5 }, (_, i) => `line ${i}`);
  const input = { kind: "project", lines: [...lines, null, 9, {}], intelligence: { provider: "ollama", ollamaModel: " m " } };
  const validated = validateLocalSummaryRequest(input);
  assert.deepEqual(validated, { kind: "project", lines: lines.slice(5), intelligence: normalizeAyaIntelligenceConfig(input.intelligence) });
  assert.equal(input.lines.length, lines.length + 3);
  assert.notEqual(validated.lines, input.lines);
  assert.deepEqual(validateLocalSummaryRequest({ kind: "other", lines: ["", " x ", false], intelligence: false }), { kind: "terminal", lines: ["", " x "] });
  assert.deepEqual(validateLocalSummaryRequest({ lines: [], intelligence: "invalid" }), { kind: "terminal", lines: [], intelligence: undefined });
});

test("the Apple helper path is beside the built modules and ignores the e2e chat override", (t) => {
  const saved = process.env.AYA_E2E_APPLE_HELPER;
  t.after(() => {
    if (saved === undefined) delete process.env.AYA_E2E_APPLE_HELPER;
    else process.env.AYA_E2E_APPLE_HELPER = saved;
  });
  process.env.AYA_E2E_APPLE_HELPER = join(process.cwd(), "unused-stand-in");
  assert.equal(appleHelperPath(), join(process.cwd(), "dist-electron", "aya-local-summary"));
});

test("Apple summaries reject unsupported platforms before accessing or spawning anything", async () => {
  const s = setup({ platform: () => "linux" });
  assert.deepEqual(await summarizeWithApple(s.deps, req), unavailableLocalSummary("unsupported-platform"));
  assert.deepEqual(s.log, []);
});

test("Apple summaries check executable access and return helper-missing without spawning", async () => {
  const seen = [];
  const s = setup({ access: async (...args) => { seen.push(args); throw new Error("denied"); } });
  assert.deepEqual(await summarizeWithApple(s.deps, req), unavailableLocalSummary("helper-missing"));
  assert.deepEqual(seen, [[appleHelperPath(), fsConstants.X_OK]]);
  assert.deepEqual(s.log, []);
});

test("Apple sends the unchanged request after access, spawn and stream setup, and joins split output", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  assert.deepEqual(s.log, [
    ["access", appleHelperPath(), fsConstants.X_OK],
    ["spawn", appleHelperPath(), [], { stdio: ["pipe", "pipe", "pipe"] }],
    ["encoding", "stdout", "utf-8"],
    ["encoding", "stderr", "utf-8"],
    ["stdin", JSON.stringify(req)],
  ]);
  s.child.stdin.emit("error", new Error("broken pipe"));
  s.child.stdout.emit("data", '{"available":true,"useful":true,');
  s.child.stdout.emit("data", '"summary":"  Building\\n  Aya "}');
  s.child.emit("close", 0);
  assert.deepEqual(await pending, { available: true, useful: true, summary: "Building Aya" });
  t.mock.timers.tick(20_000);
  assert.equal(s.log.some(([what]) => what === "kill"), false, "successful completion clears the timer");
});

test("Apple uses strict booleans, hides non-useful text, caps summaries and normalizes helper errors", async () => {
  for (const [reply, expected] of [
    [{ available: true, useful: false, summary: "hidden" }, empty],
    [{ available: "yes", useful: true, summary: "label" }, { available: false, useful: true, summary: "label" }],
    [{ available: true, useful: "yes", summary: "hidden" }, empty],
    [{ available: true, useful: true, summary: " \n " }, empty],
    [{ available: true, useful: true, summary: 7 }, empty],
    [{ available: true, useful: true, summary: "x".repeat(200) }, { available: true, useful: true, summary: "x".repeat(SUMMARY_TEXT_MAX_CHARS) }],
    [{ available: false, error: "Model is unavailable\n details" }, unavailableLocalSummary("apple-model-unavailable")],
    [{ available: true, error: " \n " }, { ...empty, error: undefined }],
  ]) assert.deepEqual(await appleReply(reply), expected);
});

test("Apple rejects invalid JSON, prefers stderr on a nonzero exit, and falls back to the exit code", async () => {
  assert.deepEqual(await appleReply("not JSON"), unavailableLocalSummary("invalid-helper-json"));
  assert.deepEqual(await appleReply("{}", 2), unavailableLocalSummary("helper-exit-2"));
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  s.child.stderr.emit("data", " assetsUnavailable\n details ");
  s.child.stdout.emit("data", '{"available":true,"summary":"ignored"}');
  s.child.emit("close", 1);
  assert.deepEqual(await pending, unavailableLocalSummary("apple-model-unavailable"));
});

test("Apple spawn errors settle once and clear the timeout even if a close follows", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  s.child.emit("error", new Error("spawn ENOTDIR"));
  s.child.emit("close", -1);
  assert.deepEqual(await pending, unavailableLocalSummary("helper-not-executable"));
  t.mock.timers.tick(20_000);
  assert.equal(s.log.some(([what]) => what === "kill"), false);
});

test("Apple kills a helper at exactly 20 seconds and ignores a later answer", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  let settled = false;
  pending.then(() => { settled = true; });
  t.mock.timers.tick(19_999);
  await turn();
  assert.equal(settled, false);
  assert.equal(s.log.some(([what]) => what === "kill"), false);
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, unavailableLocalSummary("timeout"));
  assert.deepEqual(s.log.at(-1), ["kill", "SIGKILL"]);
  s.child.stdout.emit("data", '{"available":true,"useful":true,"summary":"late"}');
  s.child.emit("close", 0);
  assert.deepEqual(await pending, unavailableLocalSummary("timeout"));
});

test("Apple capture keeps a chunk crossing the existing cap, drops later chunks, and does not kill", async () => {
  const s = setup();
  const pending = summarizeWithApple(s.deps, req);
  await turn();
  s.child.stdout.emit("data", JSON.stringify({ available: true, useful: true, summary: "label", padding: "x".repeat(APPLE_HELPER_STDOUT_MAX_BYTES) }));
  s.child.stdout.emit("data", "invalid trailing output");
  s.child.emit("close", 0);
  assert.deepEqual(await pending, { available: true, useful: true, summary: "label" });
  assert.equal(s.log.some(([what]) => what === "kill"), false);

  const stderr = setup();
  const failed = summarizeWithApple(stderr.deps, req);
  await turn();
  stderr.child.stderr.emit("data", "x".repeat(APPLE_HELPER_STDOUT_MAX_BYTES));
  stderr.child.stderr.emit("data", "assetsUnavailable");
  stderr.child.emit("close", 1);
  assert.deepEqual(await failed, unavailableLocalSummary("x".repeat(SUMMARY_TEXT_MAX_CHARS)));
});

test("chat summaries normalize failures, allow empty content, and use the shared JSON and text parser", () => {
  assert.deepEqual(summaryFromChat({ ok: false, error: " assetsUnavailable " }), unavailableLocalSummary("apple-model-unavailable"));
  assert.deepEqual(summaryFromChat({ ok: true, content: "" }), empty);
  assert.deepEqual(summaryFromChat({ ok: true, content: '```json\n{"useful":true,"summary":"Building Aya"}\n```' }), { available: true, useful: true, summary: "Building Aya" });
  assert.deepEqual(summaryFromChat({ ok: true, content: "one two three four five six seven" }), { available: true, useful: true, summary: "one two three four five six" });
  assert.deepEqual(summaryFromChat({ ok: true, content: '{"useful":false,"summary":"hidden"}' }), empty);
});

test("summaries default to Apple and explicitly select Apple without calling the HTTP provider", async () => {
  for (const intelligence of [undefined, normalizeAyaIntelligenceConfig({})]) {
    const s = setup({ platform: () => "linux" });
    assert.deepEqual(await summarizeLocal(s.deps, { ...req, intelligence }), unavailableLocalSummary("unsupported-platform"));
    assert.deepEqual(s.log, []);
  }
});

test("Ollama and OpenAI summaries forward the exact prompt and common sampling and timeout settings", async () => {
  for (const provider of ["ollama", "openai"]) {
    const s = setup();
    const request = { ...req, kind: "project", intelligence: normalizeAyaIntelligenceConfig({ provider }) };
    assert.deepEqual(await summarizeLocal(s.deps, request), { available: true, useful: true, summary: "Building Aya" });
    assert.deepEqual(s.log, [["chat", request.intelligence,
      "You summarize terminal output for a developer tool. Return JSON only.",
      summaryPrompt(request), { temperature: 0.2, maxTokens: 64, timeoutMs: 20_000 },
    ]]);
  }
  const failed = setup({ providerChat: async () => ({ ok: false, error: " api-http-500\n " }) });
  assert.deepEqual(await summarizeLocal(failed.deps, { ...req, intelligence: normalizeAyaIntelligenceConfig({ provider: "openai" }) }), unavailableLocalSummary("api-http-500"));
});

test("default HTTP chat delegates to intelligence-chat using a stand-in fetch", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push([url, JSON.parse(options.body)]);
    return { ok: true, json: async () => ({ message: { content: '{"useful":true,"summary":"Building Aya"}' } }) };
  });
  const s = setup();
  delete s.deps.providerChat;
  const intelligence = normalizeAyaIntelligenceConfig({ provider: "ollama", ollamaModel: "test:model" });
  assert.deepEqual(await summarizeLocal(s.deps, { ...req, intelligence }), { available: true, useful: true, summary: "Building Aya" });
  assert.equal(calls[0][0], "http://localhost:11434/api/chat");
  assert.deepEqual(calls[0][1].options, { temperature: 0.2, num_predict: 64 });
  assert.equal(calls[0][1].model, "test:model");
});

test("Ollama status returns the missing-install shape without making an HTTP request", async () => {
  const s = setup({ findExecutableOnPath: () => null });
  assert.deepEqual(await ollamaStatus(s.deps), {
    installed: false, running: false, path: null, models: [], recommendedModel: RECOMMENDED_OLLAMA_MODEL,
    recommendedModelInstalled: false, message: "Ollama is not installed or not on PATH.",
  });
  assert.deepEqual(s.log, []);
});

test("Ollama status probes tags with the original timeout and keeps model order and exact matches", async (t) => {
  const signal = new AbortController().signal;
  const timeouts = [];
  t.mock.method(AbortSignal, "timeout", (ms) => (timeouts.push(ms), signal));
  const s = setup({ fetch: async (...args) => {
    s.log.push(["fetch", ...args]);
    return { ok: true, json: async () => ({ models: [
      { name: "m:tag", model: "ignored" }, { name: 2, model: "other" }, { model: "m:tag" }, {}, { name: "", model: "ignored" },
    ] }) };
  } });
  assert.deepEqual(await ollamaStatus(s.deps, "m:tag"), {
    installed: true, running: true, path: "/stand-in/ollama", models: ["m:tag", "other", "m:tag"],
    recommendedModel: "m:tag", recommendedModelInstalled: true,
  });
  assert.deepEqual(s.log, [["find", "ollama"], ["fetch", "http://localhost:11434/api/tags", { signal }]]);
  assert.deepEqual(timeouts, [COMMAND_PROBE_TIMEOUT_MS]);
  assert.equal((await ollamaStatus(s.deps, "m")).recommendedModelInstalled, false);
});

test("Ollama status accepts missing or non-array model lists as an empty running server", async () => {
  for (const json of [{}, { models: null }, { models: {} }]) {
    const s = setup({ fetch: async () => ({ ok: true, json: async () => json }) });
    assert.deepEqual(await ollamaStatus(s.deps), {
      installed: true, running: true, path: "/stand-in/ollama", models: [], recommendedModel: RECOMMENDED_OLLAMA_MODEL,
      recommendedModelInstalled: false,
    });
  }
});

test("Ollama status reports HTTP, fetch and JSON errors without losing installed state", async () => {
  for (const [fetch, message] of [
    [async () => ({ ok: false, status: 503, json: () => assert.fail("HTTP failures skip JSON") }), "Ollama API returned HTTP 503."],
    [async () => { throw new Error("connection refused"); }, "connection refused"],
    [async () => { throw "offline"; }, "offline"],
    [async () => ({ ok: true, json: async () => { throw new Error("invalid JSON"); } }), "invalid JSON"],
  ]) {
    const s = setup({ fetch });
    assert.deepEqual(await ollamaStatus(s.deps, "custom"), {
      installed: true, running: false, path: "/stand-in/ollama", models: [], recommendedModel: "custom",
      recommendedModelInstalled: false, message,
    });
  }
});

test("Ollama model validation trims supported names and keeps the original character and length limits", () => {
  for (const name of ["gemma4:e4b", "owner/model.v1:tag-2", "a_b", "-model", "x".repeat(120)]) {
    assert.equal(validateOllamaModelName(` ${name}\n`), name);
  }
  for (const name of ["", " ", "x".repeat(121), "model name", "m;id", "$(id)", "m\\x", "m\nx", "模型"]) {
    assert.throws(() => validateOllamaModelName(name), { message: "Ollama model name contains unsupported characters." });
  }
  for (const value of [undefined, null, 7, {}]) {
    assert.throws(() => validateOllamaModelName(value), { message: "Invalid IPC payload for intelligence:pull-ollama-model.model: expected string." });
  }
});

test("Ollama pull rejects a missing executable without spawning or probing", async () => {
  const s = setup({ findExecutableOnPath: () => null });
  await assert.rejects(pullOllamaModel(s.deps, "m"), { message: "Ollama is not installed or not on PATH." });
  assert.deepEqual(s.log, []);
});

test("Ollama pull waits for a successful close before looking up the live PATH again and probing the pulled model", async () => {
  let lookup = 0;
  const s = setup({
    findExecutableOnPath: (name) => (s.log.push(["find", name]), ++lookup === 1 ? "/before/ollama" : "/after/ollama"),
    fetch: async () => (s.log.push(["tags"]), { ok: true, json: async () => ({ models: [{ name: "custom:model" }] }) }),
  });
  const pending = pullOllamaModel(s.deps, "custom:model");
  assert.deepEqual(s.log, [
    ["find", "ollama"], ["spawn", "/before/ollama", ["pull", "custom:model"], { stdio: ["ignore", "pipe", "pipe"] }],
    ["encoding", "stderr", "utf-8"],
  ]);
  s.child.stderr.emit("data", "download progress");
  await turn();
  assert.equal(lookup, 1);
  s.child.emit("close", 0);
  assert.deepEqual(await pending, {
    installed: true, running: true, path: "/after/ollama", models: ["custom:model"], recommendedModel: "custom:model",
    recommendedModelInstalled: true,
  });
  assert.deepEqual(s.log.slice(-2), [["find", "ollama"], ["tags"]]);
});

test("Ollama pull reports stderr, blank-stderr exit codes and spawn errors without probing", async () => {
  for (const [chunks, code, message] of [
    [[" first\n", " detail "], 2, "first\n detail"], [[], 3, "ollama pull exited 3"], [[" \n "], null, "ollama pull exited null"],
  ]) {
    const s = setup();
    const pending = pullOllamaModel(s.deps, "m");
    for (const chunk of chunks) s.child.stderr.emit("data", chunk);
    s.child.emit("close", code);
    await assert.rejects(pending, { message });
    assert.equal(s.log.some(([what]) => what === "fetch"), false);
  }
  const s = setup();
  const pending = pullOllamaModel(s.deps, "m");
  const error = new Error("spawn failed");
  s.child.emit("error", error);
  s.child.emit("close", -1);
  await assert.rejects(pending, (actual) => actual === error);
  assert.equal(s.log.some(([what]) => what === "fetch"), false);
});

test("Ollama pull captures the full chunk crossing 8192 characters and drops subsequent stderr", async () => {
  const s = setup();
  const pending = pullOllamaModel(s.deps, "m");
  s.child.stderr.emit("data", "x".repeat(8191));
  s.child.stderr.emit("data", "yz");
  s.child.stderr.emit("data", "ignored");
  s.child.emit("close", 1);
  await assert.rejects(pending, { message: `${"x".repeat(8191)}yz` });
});

test("settings IPC composes moved validation, summary, status and pull functions against stand-ins", async () => {
  const s = setup();
  const handlers = new Map();
  registerSettingsIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    senderWindow: () => null,
    dialog: {},
    home: () => assert.fail("intelligence does not need the user's home"),
    presetsSaved: async () => {},
    intelligence: {
      summarize: (req) => summarizeLocal(s.deps, validateLocalSummaryRequest(req)),
      ollamaStatus: (model) => ollamaStatus(s.deps, model),
      pullOllamaModel: (model) => pullOllamaModel(s.deps, validateOllamaModelName(model)),
    },
  });
  const call = (channel, payload) => handlers.get(channel)({}, payload);
  await assert.rejects(call("local-summary:summarize", null), /req must be an object/);
  assert.deepEqual(await call("local-summary:summarize", { ...req, intelligence: { provider: "openai" } }), { available: true, useful: true, summary: "Building Aya" });
  assert.equal((await call("intelligence:ollama-status", " custom:model ")).recommendedModel, "custom:model");
  await assert.rejects(call("intelligence:pull-ollama-model", "invalid model"), /unsupported characters/);
  assert.equal(s.log.some(([what]) => what === "spawn"), false);
  const pending = call("intelligence:pull-ollama-model", " custom:model ");
  assert.deepEqual(s.log.find(([what]) => what === "spawn")[2], ["pull", "custom:model"]);
  s.child.emit("close", 0);
  assert.equal((await pending).recommendedModel, "custom:model");
});
