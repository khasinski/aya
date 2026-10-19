import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { once } from "node:events";
export const require = createRequire(import.meta.url);
export const { PtyOwnerClient, ownerArtifactPaths } = require("../../dist-electron/pty-owner-client.js");
export const artifacts = ownerArtifactPaths(process.env.AYA_OWNER_ARTIFACT_DIR || path.resolve("dist-electron"));
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export async function startOwner(executable = artifacts.executable) {
  fs.mkdirSync("test-results", { recursive: true });
  const home = fs.mkdtempSync(path.resolve("test-results/owner-")); fs.chmodSync(home, 0o700);
  // Relative socket paths keep deep review worktrees below sockaddr_un's limit.
  const socket = path.relative(process.cwd(), path.join(home, "o")), token = randomBytes(32);
  const env = { PATH: "/usr/bin:/bin", HOME: home, AYA_HOME: home, LANG: "C", TERM: "xterm-256color" };
  const args = ["--socket", socket, "--token-fd", "3"];
  const owner = spawn(executable, args, { env, cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe", "pipe"] });
  owner.stdio[3].on("error", () => {}); owner.stdio[3].end(token);
  let stderr = ""; owner.stderr.on("data", (data) => { stderr += data; });
  const closed = new Promise((resolve) => owner.once("close", (code, signal) => resolve({ code, signal, stderr })));
  await Promise.race([once(owner.stdout, "data"), closed.then((result) => { throw new Error(`Owner failed to start: ${JSON.stringify(result)}`); })]);
  const clients = [];
  return { home, socket, token, owner, args, env, closed, clients,
    async connect() { const c = await PtyOwnerClient.connect(socket, token, artifacts.bridge); clients.push(c); return c; },
    async close() {
      for (const c of clients) c.close();
      if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
      const timer = setTimeout(() => owner.kill("SIGKILL"), 2000);
      await closed; clearTimeout(timer); fs.rmSync(home, { recursive: true, force: true });
    } };
}
export function shellSpec(home, id = "shell") {
  return { id, cols: 80, rows: 24, cwd: home, command: "/bin/sh", env: { PATH: "/usr/bin:/bin", LANG: "C", TERM: "xterm-256color", HOME: home },
    argv: ["sh", "-c", "stty -echo; printf 'START:%s\\n' \"$$\"; while IFS= read -r line; do case \"$line\" in size) printf 'SIZE:%s:' \"$$\"; stty size ;; quit) printf 'EXIT:%s\\n' \"$$\"; exit 23 ;; *) printf 'R:%s:%s\\n' \"$$\" \"$line\" ;; esac; done"] };
}
export async function readUntil(client, fd, needle, timeout = 5000) {
  let text = ""; const end = Date.now() + timeout, buffer = Buffer.alloc(65536);
  while (!text.includes(needle)) {
    if (Date.now() >= end) throw new Error(`PTY output timeout: ${JSON.stringify({ needle, text })}`);
    if (client.readReady(fd)) {
      try { const count = fs.readSync(fd, buffer); text += buffer.toString("utf8", 0, count); }
      catch (error) { if (!["EIO", "EAGAIN"].includes(error.code)) throw error; }
    }
    if (!text.includes(needle)) await sleep(2);
  }
  return text;
}
export function frame(type, payload = Buffer.alloc(0), id = 1) {
  const b = Buffer.alloc(16 + payload.length); b.writeUInt32BE(0x41594150); b.writeUInt16BE(2, 4); b.writeUInt16BE(type, 6);
  b.writeUInt32BE(id, 8); b.writeUInt32BE(payload.length, 12); payload.copy(b, 16); return b;
}
export function string(value) { const b = Buffer.from(value), length = Buffer.alloc(4); length.writeUInt32BE(b.length); return Buffer.concat([length, b]); }
