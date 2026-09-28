// The HTTP chat shared by terminal summaries and role drafts, against a fake
// Ollama / OpenAI-compatible server.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ollamaChat, openAiChat, openAiBaseUrl } from "../dist-electron/intelligence-chat.js";

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
