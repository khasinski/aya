// The renderer's Aya Intelligence defaults point at the Ollama the main process
// talks to. electron/main.ts cannot be imported here (it starts the app), so
// its recommended model is pinned by reading its source.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { OLLAMA_OPENAI_BASE_URL, RECOMMENDED_OLLAMA_MODEL } from "../dist-test/ollama-defaults.js";
import { OLLAMA_BASE_URL } from "../dist-electron/intelligence-chat.js";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("the default OpenAI-compatible URL is main's Ollama base plus /v1", () => {
  assert.equal(OLLAMA_OPENAI_BASE_URL, "http://localhost:11434/v1");
  assert.equal(OLLAMA_OPENAI_BASE_URL, `${OLLAMA_BASE_URL}/v1`);
});

test("the default model is the one main recommends pulling", () => {
  assert.equal(RECOMMENDED_OLLAMA_MODEL, "gemma4:e4b");
  const main = readFileSync(path.join(root, "electron/main.ts"), "utf8");
  assert.match(main, /const RECOMMENDED_OLLAMA_MODEL = "gemma4:e4b";/);
});
