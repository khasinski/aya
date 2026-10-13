import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isInternalNavigationUrl,
  parseExternalUrl,
  openExternalUrl,
} from "../dist-electron/navigation.js";

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

function externalShell(over = {}) {
  const calls = [];
  const deps = { shell: {
    openPath: async (file) => (calls.push(["path", file]), ""),
    openExternal: async (url) => void calls.push(["external", url]),
    ...over,
  } };
  return { deps, calls };
}

test("external browser and editor URLs use openExternal with the parsed URL", async () => {
  const { deps, calls } = externalShell();
  const urls = ["HTTP://EXAMPLE.COM", "https://example.com/a b", "vscode://file/project", "vscode-insiders://file/project", "cursor://file/project", "zed://file/project", "jetbrains://idea/project"];
  for (const url of urls) await openExternalUrl(url, deps);
  assert.deepEqual(calls, urls.map((url) => ["external", new URL(url).toString()]));
});

test("external file URLs decode the path and use openPath alone", async () => {
  const { deps, calls } = externalShell();
  await openExternalUrl("file:///tmp/aya%20project/it%27s.txt", deps);
  assert.deepEqual(calls, [["path", "/tmp/aya project/it's.txt"]]);
});

test("unsupported external URLs fail with the original message before using the shell", async () => {
  const { deps, calls } = externalShell();
  for (const url of ["javascript:alert(1)", "data:text/plain,hi", "mailto:dev@example.com", "not a url"]) {
    await assert.rejects(openExternalUrl(url, deps), { message: "Unsupported external URL." });
  }
  assert.deepEqual(calls, []);
});

test("openPath's error string and rejected shell calls reach the caller", async () => {
  const pathError = externalShell({ openPath: async () => "No application for this file" });
  await assert.rejects(openExternalUrl("file:///tmp/aya.txt", pathError.deps), { message: "No application for this file" });
  const failure = new Error("shell rejected");
  const rejected = externalShell({ openExternal: async () => { throw failure; }, openPath: async () => { throw failure; } });
  await assert.rejects(openExternalUrl("https://example.com", rejected.deps), (err) => err === failure);
  await assert.rejects(openExternalUrl("file:///tmp/aya.txt", rejected.deps), (err) => err === failure);
});

test("opening an external URL settles only after the shell finishes", async () => {
  let release;
  const { deps } = externalShell({ openExternal: () => new Promise((resolve) => (release = resolve)) });
  let done = false;
  const opened = openExternalUrl("https://example.com", deps).then(() => (done = true));
  await Promise.resolve();
  assert.equal(done, false);
  release();
  await opened;
  assert.equal(done, true);
});
