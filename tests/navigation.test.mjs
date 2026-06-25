import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInternalNavigationUrl,
  parseExternalUrl,
  parseHttpUrl,
} from "../dist-electron/navigation.js";

test("parseHttpUrl accepts only http and https URLs", () => {
  assert.equal(parseHttpUrl("https://example.com/a?b=c")?.toString(), "https://example.com/a?b=c");
  assert.equal(parseHttpUrl("http://example.com/")?.toString(), "http://example.com/");
  assert.equal(parseHttpUrl("file:///Applications/Aya.app/Contents/index.html"), null);
  assert.equal(parseHttpUrl("javascript:alert(1)"), null);
  assert.equal(parseHttpUrl("not a url"), null);
});

test("parseExternalUrl accepts browser, file, and editor links only", () => {
  assert.equal(parseExternalUrl("https://example.com/a?b=c")?.protocol, "https:");
  assert.equal(parseExternalUrl("file:///Users/dev/project/src/App.ts")?.protocol, "file:");
  assert.equal(parseExternalUrl("vscode://file/Users/dev/project/src/App.ts")?.protocol, "vscode:");
  assert.equal(parseExternalUrl("cursor://file/Users/dev/project/src/App.ts")?.protocol, "cursor:");
  assert.equal(parseExternalUrl("zed://file/Users/dev/project/src/App.ts")?.protocol, "zed:");
  assert.equal(parseExternalUrl("jetbrains://idea/navigate/reference?project=x")?.protocol, "jetbrains:");
  assert.equal(parseExternalUrl("javascript:alert(1)"), null);
  assert.equal(parseExternalUrl("data:text/html,hi"), null);
  assert.equal(parseExternalUrl("not a url"), null);
});

test("internal navigation allows the dev-server origin in dev", () => {
  const options = { isDev: true, devServerUrl: "http://localhost:5183" };
  assert.equal(isInternalNavigationUrl("http://localhost:5183/index.html", options), true);
  assert.equal(isInternalNavigationUrl("http://localhost:5184/index.html", options), false);
  assert.equal(isInternalNavigationUrl("https://example.com", options), false);
});

test("internal navigation allows file URLs in production", () => {
  const options = {
    isDev: false,
    devServerUrl: "http://localhost:5183",
    appIndexPath: "/Applications/Aya.app/Contents/Resources/dist/index.html",
  };
  assert.equal(
    isInternalNavigationUrl(
      "file:///Applications/Aya.app/Contents/Resources/dist/index.html",
      options,
    ),
    true,
  );
  assert.equal(
    isInternalNavigationUrl("file:///Users/dev/project/src/App.ts", options),
    false,
  );
  assert.equal(isInternalNavigationUrl("https://example.com", options), false);
});
