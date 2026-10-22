import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TerminalStatusDot } from "../dist-test/components/TerminalStatusDot.js";

function render(status, extra = {}) {
  const terminal = {
    name: "shell 1",
    status,
    stopped: false,
    disconnected: false,
    spawnFailure: undefined,
    exitCode: null,
    ...extra,
  };
  return renderToStaticMarkup(createElement(TerminalStatusDot, { terminal }));
}

function expectDot(status, text, extra) {
  const markup = render(status, extra);
  assert.match(markup, /role="img"/);
  assert.match(markup, new RegExp(`aria-label="shell 1: ${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
  assert.match(markup, new RegExp(`title="${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
}

test("each sidebar dot state has a screen-reader label and visible tooltip", () => {
  expectDot("running", "Terminal is running.");
  expectDot("waiting", "Terminal is waiting for your input. Select it to respond.");
  expectDot("idle", "Terminal is idle.");
  expectDot("idle", "Terminal is stopped. Press Shift+Enter to restart it.", { stopped: true });
  expectDot("idle", "Terminal finished successfully.", { exitCode: 0 });
  expectDot("idle", "Terminal exited with code 2.", { exitCode: 2 });
  expectDot("error", "Terminal is disconnected. Select it to view recovery options.", { disconnected: true });
  const remote = render("running", { disconnected: true, remoteDisconnected: true });
  assert.match(remote, /aya-sidebar-statusdot--disconnected/);
  assert.match(remote, /Remote terminal is disconnected\. Aya is trying to reconnect\./);
  assert.doesNotMatch(remote, /statusdot--error/);
  expectDot("error", "Terminal could not start. Select it to view the error.", {
    spawnFailure: { reason: "command-not-found", detail: "missing" },
  });
  expectDot("error", "Terminal needs attention. Select it to view details.");
});

test("status-dot copy avoids internal transport names", () => {
  for (const status of ["running", "waiting", "idle", "error"]) {
    const markup = render(status, status === "error" ? { disconnected: true } : {});
    assert.doesNotMatch(markup, /\b(?:pty|host|owner|socket)\b/i);
  }
});
