import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInternalNavigationUrl,
  parseHttpUrl,
} from "../dist-electron/navigation.js";

test("parseHttpUrl accepts only http and https URLs", () => {
  assert.equal(parseHttpUrl("https://example.com/a?b=c")?.toString(), "https://example.com/a?b=c");
  assert.equal(parseHttpUrl("http://example.com/")?.toString(), "http://example.com/");
  assert.equal(parseHttpUrl("file:///Applications/Aya.app/Contents/index.html"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("not a url"), null);
});

test("internal navigation allows the dev-server origin in dev", () => {
  const options = { isDev: true, devServerUrl: "http://localhost:5183" };
  assert.equal(isInternalNavigationUrl("http://localhost:5183/index.html", options), true);
  assert.equal(isInternalNavigationUrl("http://localhost:5184/index.html", options), false);
  assert.equal(isInternalNavigationUrl("https://example.com", options), false);
});

test("internal navigation allows file URLs in production", () => {
  const options = { isDev: false, devServerUrl: "http://localhost:5183" };
  assert.equal(isInternalNavigationUrl("file:///Applications/Aya.app/Contents/index.html", options), true);
  assert.equal(isInternalNavigationUrl("https://example.com", options), false);
});
