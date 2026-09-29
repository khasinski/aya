// The renderer's Aya Intelligence defaults point at the Ollama the main process
// talks to.

import { test } from "node:test";
import assert from "node:assert/strict";

import { OLLAMA_OPENAI_BASE_URL, RECOMMENDED_OLLAMA_MODEL } from "../dist-test/ollama-defaults.js";
import * as main from "../dist-electron/intelligence-chat.js";

test("the default OpenAI-compatible URL is main's Ollama base plus /v1", () => {
  assert.equal(OLLAMA_OPENAI_BASE_URL, "http://localhost:11434/v1");
  assert.equal(OLLAMA_OPENAI_BASE_URL, main.OLLAMA_OPENAI_BASE_URL);
  assert.equal(main.OLLAMA_OPENAI_BASE_URL, `${main.OLLAMA_BASE_URL}/v1`);
});

test("the default model is the one main recommends pulling", () => {
  assert.equal(RECOMMENDED_OLLAMA_MODEL, "gemma4:e4b");
  assert.equal(RECOMMENDED_OLLAMA_MODEL, main.RECOMMENDED_OLLAMA_MODEL);
});
