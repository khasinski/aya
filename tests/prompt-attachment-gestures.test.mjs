import { test } from "node:test";
import assert from "node:assert/strict";
import { installPromptAttachmentGestures } from "../dist-electron/prompt-attachment-gestures.js";

function harness() {
  const listeners = new Map();
  const paneElement = { contains: (node) => node === activeElement };
  const activeElement = {};
  const pane = { id: "pane-gesture", element: paneElement };
  paneElement.getAttribute = () => pane.id;
  const target = { closest: (selector) => selector === "[data-terminal-id]" ? paneElement : null };
  const doc = {
    activeElement,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type) => listeners.delete(type),
  };
  const calls = [];
  const reports = [];
  const cleanup = installPromptAttachmentGestures({
    document: doc,
    getPathForFile: (file) => `/selected/${file.name}`,
    invoke: async (channel, ...args) => {
      calls.push([channel, ...args]);
      if (channel.startsWith("prompt-attachments:register-")) return "opaque-one-use-token";
      return { status: "added" };
    },
    report: (report) => reports.push(report),
  });
  return { listeners, pane, target, doc, calls, reports, cleanup };
}

function event(overrides = {}) {
  return {
    isTrusted: false,
    target: null,
    defaultPrevented: false,
    propagationStopped: false,
    preventDefault() { this.defaultPrevented = true; },
    stopImmediatePropagation() { this.propagationStopped = true; },
    ...overrides,
  };
}

test("renderer-created drop and paste events cannot request file or clipboard authority", () => {
  const h = harness();
  const drop = event({ target: h.target, dataTransfer: { files: [{ name: "secret.txt", type: "text/plain" }] } });
  const paste = event({ target: h.target, clipboardData: { types: ["image/png"], getData: () => "" } });
  h.listeners.get("drop")(drop);
  h.listeners.get("paste")(paste);
  assert.deepEqual(h.calls, []);
  assert.deepEqual(h.reports, []);
  assert.equal(drop.defaultPrevented, false);
  assert.equal(paste.defaultPrevented, false);
  h.cleanup();
});

test("trusted file drop resolves OS paths in preload and uses only a one-use token", async () => {
  const h = harness();
  const drop = event({ isTrusted: true, target: h.target, dataTransfer: { files: [{ name: "report.txt", type: "text/plain" }] } });
  h.listeners.get("drop")(drop);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(drop.defaultPrevented, true);
  assert.deepEqual(h.calls, [
    ["prompt-attachments:register-drop", "pane-gesture", [{ name: "report.txt", mimeType: "text/plain", path: "/selected/report.txt" }]],
    ["prompt-attachments:drop", "opaque-one-use-token"],
  ]);
  assert.equal(h.reports[0].phase, "started");
  assert.equal(h.reports[1].phase, "finished");
  h.cleanup();
});

test("trusted image paste is routed only from the focused terminal pane", async () => {
  const h = harness();
  const paste = event({ isTrusted: true, target: h.target, clipboardData: { types: ["image/png"], getData: () => "" } });
  h.listeners.get("paste")(paste);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(paste.defaultPrevented, true);
  assert.deepEqual(h.calls, [
    ["prompt-attachments:register-paste", "pane-gesture"],
    ["prompt-attachments:clipboard-image", "opaque-one-use-token"],
  ]);
  assert.equal(h.reports.at(-1).kind, "image");
  h.cleanup();
});

test("an image paste outside the focused terminal does not request clipboard access", () => {
  const h = harness();
  h.doc.activeElement = {};
  const paste = event({ isTrusted: true, target: h.target, clipboardData: { types: ["image/png"], getData: () => "" } });
  h.listeners.get("paste")(paste);
  assert.deepEqual(h.calls, []);
  assert.equal(paste.defaultPrevented, false);
  h.cleanup();
});
