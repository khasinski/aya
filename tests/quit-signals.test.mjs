// A termination signal runs the ordinary quit without its questions (the quit
// still announces the terminal host transfer); a repeated signal is not caught.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const { installQuitSignals, QUIT_SIGNALS } = await import("../dist-electron/quit-signals.js");

test("each termination signal quits once, then is left to its default action", () => {
  const proc = new EventEmitter(), quits = [];
  installQuitSignals(proc, (signal) => quits.push(signal));
  assert.deepEqual(QUIT_SIGNALS, ["SIGTERM", "SIGINT", "SIGHUP"]);
  for (const signal of QUIT_SIGNALS) assert.equal(proc.listenerCount(signal), 1);
  proc.emit("SIGTERM");
  assert.deepEqual(quits, ["SIGTERM"]);
  assert.equal(proc.listenerCount("SIGTERM"), 0);
  assert.equal(proc.listenerCount("SIGINT"), 1);
  proc.emit("SIGINT"); proc.emit("SIGHUP");
  assert.deepEqual(quits, ["SIGTERM", "SIGINT", "SIGHUP"]);
});

test("a real process quits gracefully on the first SIGTERM and dies on the second", async () => {
  const module = fileURLToPath(new URL("../dist-electron/quit-signals.js", import.meta.url));
  // The quit never finishes, like one held by a slow before-quit step.
  const child = spawn(process.execPath, ["-e", `require(${JSON.stringify(module)}).installQuitSignals(process,s=>console.log("quit "+s));console.log("ready");setInterval(()=>{},1000);`], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  const seen = (text) => new Promise((resolve) => { const check = () => { if (out.includes(text)) resolve(); else child.stdout.once("data", check); }; check(); });
  child.stdout.on("data", (chunk) => { out += chunk; });
  const exited = new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal })));
  await seen("ready");
  child.kill("SIGTERM");
  await seen("quit SIGTERM");
  assert.equal(child.exitCode, null);
  child.kill("SIGTERM");
  assert.deepEqual(await exited, { code: null, signal: "SIGTERM" });
});
