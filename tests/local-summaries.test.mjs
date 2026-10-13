import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_AYA_INTELLIGENCE,
  LOCAL_SUMMARY_CACHE_MAX_AGE_MS,
  cleanTerminalOutput,
  readAyaIntelligenceConfig,
  readSummaryCache,
  summariesFromCache,
  summaryHash,
} from "../dist-test/local-summaries.js";
import { AYA_INTELLIGENCE_STORAGE_KEY, LOCAL_SUMMARY_CACHE_STORAGE_KEY } from "../dist-test/storage-keys.js";
import { OLLAMA_OPENAI_BASE_URL, RECOMMENDED_OLLAMA_MODEL } from "../dist-test/ollama-defaults.js";

const NOW = 1_800_000_000_000;

function mockStorage(t, key, raw) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  const storage = {
    getItem(requestedKey) {
      assert.equal(requestedKey, key);
      return raw;
    },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
    else delete globalThis.localStorage;
  });
  return storage;
}

test("summary cache returns empty maps for missing, malformed, or invalid sections", (t) => {
  const storage = mockStorage(t, LOCAL_SUMMARY_CACHE_STORAGE_KEY, null);
  for (const raw of [null, "", "{", "null", "42", '"text"', "[]", "{}", '{"terminal":[],"project":null}']) {
    t.mock.method(storage, "getItem", (key) => {
      assert.equal(key, LOCAL_SUMMARY_CACHE_STORAGE_KEY);
      return raw;
    });
    assert.deepEqual(readSummaryCache(), { terminal: {}, project: {} });
  }
});

test("summary cache trims valid entries and rejects expired or malformed entries", (t) => {
  t.mock.method(Date, "now", () => NOW);
  mockStorage(t, LOCAL_SUMMARY_CACHE_STORAGE_KEY, JSON.stringify({
    terminal: {
      fresh: { summary: "  Running tests \n ", updatedAt: NOW - 1 },
      boundary: { summary: "At age limit", updatedAt: NOW - LOCAL_SUMMARY_CACHE_MAX_AGE_MS },
      expired: { summary: "Old", updatedAt: NOW - LOCAL_SUMMARY_CACHE_MAX_AGE_MS - 1 },
      blank: { summary: " \n ", updatedAt: NOW },
      wrongSummary: { summary: 12, updatedAt: NOW },
      wrongTime: { summary: "Invalid time", updatedAt: String(NOW) },
      missingTime: { summary: "Missing time" },
      missingSummary: { updatedAt: NOW },
      array: [],
      primitive: "summary",
      nil: null,
    },
    project: {
      aya: { summary: "  Building Aya  ", updatedAt: NOW },
    },
  }));
  assert.deepEqual(readSummaryCache(), {
    terminal: {
      fresh: { summary: "Running tests", updatedAt: NOW - 1 },
      boundary: { summary: "At age limit", updatedAt: NOW - LOCAL_SUMMARY_CACHE_MAX_AGE_MS },
    },
    project: { aya: { summary: "Building Aya", updatedAt: NOW } },
  });
});

test("summary cache normalizes the two sections independently and accepts future timestamps", (t) => {
  t.mock.method(Date, "now", () => NOW);
  mockStorage(t, LOCAL_SUMMARY_CACHE_STORAGE_KEY, JSON.stringify({
    terminal: false,
    project: { future: { summary: " Next run ", updatedAt: NOW + 60_000 } },
  }));
  assert.deepEqual(readSummaryCache(), {
    terminal: {},
    project: { future: { summary: "Next run", updatedAt: NOW + 60_000 } },
  });
});

test("cache projection selects summaries for the requested kind without changing the cache", () => {
  const cache = {
    terminal: { t1: { summary: "Terminal summary", updatedAt: NOW } },
    project: { aya: { summary: "Project summary", updatedAt: NOW - 1 } },
  };
  const before = structuredClone(cache);
  const terminal = summariesFromCache(cache, "terminal");
  assert.deepEqual(terminal, { t1: "Terminal summary" });
  assert.deepEqual(summariesFromCache(cache, "project"), { aya: "Project summary" });
  assert.deepEqual(summariesFromCache({ terminal: {}, project: {} }, "terminal"), {});
  terminal.t1 = "Changed projection";
  assert.deepEqual(cache, before);
});

test("storage read failures yield empty cache and default intelligence", (t) => {
  const storage = mockStorage(t, LOCAL_SUMMARY_CACHE_STORAGE_KEY, null);
  t.mock.method(storage, "getItem", () => { throw new Error("Storage unavailable"); });
  assert.deepEqual(readSummaryCache(), { terminal: {}, project: {} });
  assert.equal(readAyaIntelligenceConfig(), DEFAULT_AYA_INTELLIGENCE);
});

test("intelligence defaults use Apple and the recommended Ollama model and URL", (t) => {
  mockStorage(t, AYA_INTELLIGENCE_STORAGE_KEY, null);
  assert.deepEqual(readAyaIntelligenceConfig(), {
    provider: "apple",
    ollamaModel: RECOMMENDED_OLLAMA_MODEL,
    openAiBaseUrl: OLLAMA_OPENAI_BASE_URL,
    openAiApiKey: "",
    openAiModel: RECOMMENDED_OLLAMA_MODEL,
  });
});

test("intelligence falls back for missing and malformed storage", (t) => {
  const storage = mockStorage(t, AYA_INTELLIGENCE_STORAGE_KEY, null);
  for (const raw of [null, "", "{", "null"]) {
    t.mock.method(storage, "getItem", (key) => {
      assert.equal(key, AYA_INTELLIGENCE_STORAGE_KEY);
      return raw;
    });
    assert.equal(readAyaIntelligenceConfig(), DEFAULT_AYA_INTELLIGENCE);
  }
});

test("intelligence keeps supported providers, trims model names, and preserves URL and key text", (t) => {
  const storage = mockStorage(t, AYA_INTELLIGENCE_STORAGE_KEY, null);
  for (const provider of ["apple", "ollama", "openai"]) {
    t.mock.method(storage, "getItem", (key) => {
      assert.equal(key, AYA_INTELLIGENCE_STORAGE_KEY);
      return JSON.stringify({
        provider,
        ollamaModel: " custom:tag \n",
        openAiBaseUrl: " http://example.test/v1 ",
        openAiApiKey: " key ",
        openAiModel: " model \n",
        ignored: true,
      });
    });
    assert.deepEqual(readAyaIntelligenceConfig(), {
      provider,
      ollamaModel: "custom:tag",
      openAiBaseUrl: " http://example.test/v1 ",
      openAiApiKey: " key ",
      openAiModel: "model",
    });
  }
});

test("intelligence defaults invalid fields but preserves an explicitly empty URL", (t) => {
  mockStorage(t, AYA_INTELLIGENCE_STORAGE_KEY, JSON.stringify({
    provider: "other",
    ollamaModel: " \n ",
    openAiBaseUrl: "",
    openAiApiKey: 7,
    openAiModel: false,
  }));
  assert.deepEqual(readAyaIntelligenceConfig(), {
    ...DEFAULT_AYA_INTELLIGENCE,
    openAiBaseUrl: "",
  });
});

test("intelligence defaults missing fields and non-string model, URL, and key values", (t) => {
  mockStorage(t, AYA_INTELLIGENCE_STORAGE_KEY, JSON.stringify({
    provider: "ollama",
    ollamaModel: 7,
    openAiBaseUrl: null,
    openAiApiKey: false,
  }));
  assert.deepEqual(readAyaIntelligenceConfig(), { ...DEFAULT_AYA_INTELLIGENCE, provider: "ollama" });
});

test("terminal output removes ANSI color, cursor, OSC title, and single-character escapes", () => {
  assert.deepEqual(cleanTerminalOutput("\x1b]0;Aya title\x07\x1b[31mBuilding Aya\x1b[0m\n\x1b[2K\x1b[3;4HTests passed\x1bM"), [
    "Building Aya",
    "Tests passed",
  ]);
  assert.deepEqual(cleanTerminalOutput("\x1b]0;Aya title\x1b\\Normal output"), ["Normal output"]);
});

test("terminal output splits carriage returns, strips controls, collapses whitespace, and drops short lines", () => {
  assert.deepEqual(cleanTerminalOutput("  one\t two \x00\x01\x08\x0b\x0c\x0e\x1f\x7f\rthree\r\n \nxy\n>\n abc \n"), [
    "one two",
    "three",
    "abc",
  ]);
  assert.deepEqual(cleanTerminalOutput("\x1b[0m\r\n\txy\n"), []);
  assert.deepEqual(cleanTerminalOutput(""), []);
});

test("terminal output retains line order, duplicates, and Unicode content", () => {
  assert.deepEqual(cleanTerminalOutput("First line\nFirst line\n\u00e9\u00e9\u00e9\nLast line"), [
    "First line",
    "First line",
    "\u00e9\u00e9\u00e9",
    "Last line",
  ]);
});

test("summary hash matches FNV-1a vectors and responds to content and order", () => {
  assert.equal(summaryHash([]), "2166136261");
  assert.equal(summaryHash([""]), "2166136261");
  assert.equal(summaryHash(["hello"]), "1335831723");
  assert.equal(summaryHash(["foobar"]), "3214735720");
  assert.notEqual(summaryHash(["hello"]), summaryHash(["Hello"]));
  assert.notEqual(summaryHash(["first", "second"]), summaryHash(["second", "first"]));
});

test("summary hash retains its existing concatenation across line boundaries", () => {
  assert.equal(summaryHash(["a", "bc"]), "440920331");
  assert.equal(summaryHash(["ab", "c"]), "440920331");
});
