// Test entrypoint: intercept native questions before Aya's launch reconciliation.
const { dialog } = require("electron");
const fs = require("node:fs"), path = require("node:path");
const original = dialog.showMessageBox.bind(dialog);
globalThis.watchOwnerSpawnRequests = () => {
  const { PtyHostClient } = require("../../dist-electron/pty-host-client.js");
  const original = PtyHostClient.prototype.spawn;
  globalThis.ownerSpawnRequests = [];
  PtyHostClient.prototype.spawn = function (req) { globalThis.ownerSpawnRequests.push(req); return original.call(this, req); };
};
dialog.showMessageBox = async (...args) => {
  const options = args.at(-1);
  if (options.message !== "Work in progress will stop") return original(...args);
  fs.appendFileSync(path.join(process.env.AYA_HOME, "owner-questions.jsonl"), JSON.stringify(options) + "\n", { mode: 0o600 });
  return { response: Number(process.env.AYA_OWNER_TEST_ANSWER), checkboxChecked: false };
};
require("../../dist-electron/main.js");
