// The chat shared by terminal summaries and role drafts, against a fake
// Ollama / OpenAI-compatible server and a stand-in for the Apple helper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appleChat, ollamaChat, openAiChat, openAiBaseUrl, providerChat } from "../dist-electron/intelligence-chat.js";

const OPTS = { temperature: 0.2, maxTokens: 50, timeoutMs: 5000 };

async function fake(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(body) });
      const [status, json] = handler(req.url);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(json));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() };
}

test("ollama: posts system + user and returns the message content", async () => {
  const s = await fake(() => [200, { message: { content: "hello" } }]);
  try {
    assert.deepEqual(await ollamaChat("gemma", "sys", "usr", OPTS, s.url), { ok: true, content: "hello" });
    assert.equal(s.seen[0].url, "/api/chat");
    assert.deepEqual(s.seen[0].body.messages.map((m) => m.role), ["system", "user"]);
    assert.equal(s.seen[0].body.options.num_predict, 50);
  } finally {
    s.close();
  }
});

test("openai: /v1 is added, the key goes in the header, and an HTTP error is named", async () => {
  const s = await fake((url) => (url === "/v1/chat/completions" ? [200, { choices: [{ message: { content: "hi" } }] }] : [404, {}]));
  try {
    assert.deepEqual(await openAiChat({ baseUrl: s.url, apiKey: "k", model: "m" }, "sys", "usr", OPTS), { ok: true, content: "hi" });
    assert.equal(s.seen[0].auth, "Bearer k");
    assert.deepEqual(await openAiChat({ baseUrl: `${s.url}/nope/v1`, model: "m" }, "s", "u", OPTS), { ok: false, error: "api-http-404" });
  } finally {
    s.close();
  }
});

test("openai without a base URL or model is a config error, not a request", async () => {
  assert.deepEqual(await openAiChat({ baseUrl: "", model: "m" }, "s", "u", OPTS), { ok: false, error: "missing-api-config" });
  assert.equal(openAiBaseUrl("http://x/"), "http://x/v1");
  assert.equal(openAiBaseUrl("http://x/v1"), "http://x/v1");
});

// Apple Intelligence runs through the bundled Swift helper; a script stands in.
// `stdout` is what it prints; null means it never answers.
function fakeHelper(stdout) {
  const dir = mkdtempSync(join(tmpdir(), "aya-apple-"));
  const file = join(dir, "helper");
  const answer = stdout === null ? "setInterval(()=>{},1000);" : `process.stdout.write(${JSON.stringify(stdout)});`;
  writeFileSync(
    file,
    `#!${process.execPath}\nlet s="";process.stdin.on("data",c=>s+=c).on("end",()=>{require("fs").writeFileSync(${JSON.stringify(join(dir, "req.json"))},s);${answer}});\n`,
  );
  chmodSync(file, 0o755);
  return { file, dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("apple: sends a chat request to the helper and returns its text", async () => {
  const h = fakeHelper(JSON.stringify({ available: true, text: "hello from apple", error: null }));
  try {
    assert.deepEqual(await appleChat(h.file, "sys", "usr", OPTS), { ok: true, content: "hello from apple" });
    const sent = JSON.parse(readFileSync(join(h.dir, "req.json"), "utf8"));
    assert.deepEqual({ kind: sent.kind, system: sent.system, prompt: sent.prompt }, { kind: "chat", system: "sys", prompt: "usr" });
  } finally {
    h.done();
  }
});

test("apple: an unavailable model or a missing helper is an error, not an empty answer", async () => {
  const h = fakeHelper(JSON.stringify({ available: false, text: "", error: "unsupported-macos" }));
  try {
    assert.deepEqual(await appleChat(h.file, "s", "u", OPTS), { ok: false, error: "unsupported-macos" });
    assert.equal((await appleChat(join(h.dir, "missing"), "s", "u", OPTS)).ok, false);
  } finally {
    h.done();
  }
});

test("apple: text without an explicit available, or output that is not JSON, is an error", async () => {
  for (const [stdout, error] of [
    [JSON.stringify({ text: "maybe" }), "unavailable"],
    ["Error: model assets missing", "invalid-helper-json"],
  ]) {
    const h = fakeHelper(stdout);
    try {
      assert.deepEqual(await appleChat(h.file, "s", "u", OPTS), { ok: false, error });
    } finally {
      h.done();
    }
  }
});

test("apple: a helper that never answers is killed at the timeout", async () => {
  const h = fakeHelper(null);
  try {
    const started = Date.now();
    assert.deepEqual(await appleChat(h.file, "s", "u", { ...OPTS, timeoutMs: 300 }), { ok: false, error: "timeout" });
    assert.ok(Date.now() - started < 3000);
    assert.throws(() => execFileSync("pgrep", ["-f", h.file]), "the helper still runs");
  } finally {
    h.done();
  }
});

test("providerChat goes to the provider the config names", async () => {
  const base = { ollamaModel: "aya-test-no-such-model", openAiBaseUrl: "", openAiApiKey: "", openAiModel: "" };
  // OpenAI with no base URL is refused before any request; Ollama is asked (and fails or answers).
  assert.deepEqual(await providerChat({ ...base, provider: "openai" }, "s", "u", OPTS), { ok: false, error: "missing-api-config" });
  const ollama = await providerChat({ ...base, provider: "ollama" }, "s", "u", { ...OPTS, timeoutMs: 2000 });
  assert.notEqual(ollama.ok === false && ollama.error, "missing-api-config");
});

test("the recommended Ollama model and Ollama's URLs have one electron-side definition", async () => {
  const m = await import("../dist-electron/intelligence-chat.js");
  assert.equal(m.RECOMMENDED_OLLAMA_MODEL, "gemma4:e4b");
  assert.equal(m.OLLAMA_BASE_URL, "http://localhost:11434");
  assert.equal(m.OLLAMA_OPENAI_BASE_URL, "http://localhost:11434/v1");
  assert.equal(openAiBaseUrl(m.OLLAMA_BASE_URL), m.OLLAMA_OPENAI_BASE_URL);
});

test("openai: an empty content falls back to the reasoning, a legacy choice to its text; a blank model is a config error", async () => {
  const replies = [
    [200, { choices: [{ message: { content: "", reasoning: "thought" } }] }],
    [200, { choices: [{ text: "legacy" }] }],
  ];
  const s = await fake(() => replies.shift());
  try {
    assert.deepEqual(await openAiChat({ baseUrl: s.url, model: "m" }, "s", "u", OPTS), { ok: true, content: "thought" });
    assert.deepEqual(await openAiChat({ baseUrl: s.url, model: "m" }, "s", "u", OPTS), { ok: true, content: "legacy" });
    assert.deepEqual(await openAiChat({ baseUrl: s.url, model: "  " }, "s", "u", OPTS), { ok: false, error: "missing-api-config" });
    assert.equal(s.seen.length, 2);
  } finally {
    s.close();
  }
});
