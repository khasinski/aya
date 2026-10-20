import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  PROMPT_ATTACHMENT_RETENTION_MS,
  REMOTE_ATTACHMENT_RECEIVER,
  attachmentPathsInput,
  attachmentFilename,
  remoteAttachmentCommand,
  safeAttachmentExtension,
  saveLocalAttachment,
  uploadRemoteAttachment,
} from "../dist-electron/prompt-attachments.js";
import { registerPromptAttachmentIpc } from "../dist-electron/ipc/prompt-attachments-ipc.js";

function privateHome(t) {
  const home = mkdtempSync(join(tmpdir(), "aya-prompt-attachment-test-"));
  chmodSync(home, 0o700);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

test("attachment names are random and retain only a safe extension", () => {
  const extension = safeAttachmentExtension("../../secret name.$(touch pwn).PNG", "image/png");
  assert.equal(extension, ".png");
  const filename = attachmentFilename(extension);
  assert.match(filename, /^[a-f0-9]{32}\.png$/);
  assert.doesNotMatch(filename, /secret|touch|\.\./);
  assert.equal(safeAttachmentExtension("notes.$(bad);txt"), "");
});

test("attachment paths are shell-quoted, space separated and never contain line breaks", () => {
  assert.equal(attachmentPathsInput(["/tmp/a b.txt", "/tmp/it's.png"]), " '/tmp/a b.txt' '/tmp/it'\\''s.png' ");
  assert.throws(() => attachmentPathsInput(["/tmp/bad\npath"]), /path safely/);
});

test("local attachments use private per-project folders and cleanup files older than seven days", async (t) => {
  const home = privateHome(t);
  const first = await saveLocalAttachment(home, "project-a", Buffer.from("image"), ".png");
  const directory = join(home, "prompt-attachments", "project-a");
  assert.equal(lstatSync(join(home, "prompt-attachments")).mode & 0o777, 0o700);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first).mode & 0o777, 0o600);
  assert.equal(existsSync(first), true);

  const old = join(directory, "old.txt");
  (await import("node:fs/promises")).writeFile(old, "old", { mode: 0o600 });
  const oldDate = new Date(Date.now() - PROMPT_ATTACHMENT_RETENTION_MS - 1000);
  utimesSync(old, oldDate, oldDate);
  await saveLocalAttachment(home, "project-a", Buffer.from("next"), ".txt");
  assert.equal(existsSync(old), false);
  assert.equal(readdirSync(directory).length, 2);
});

test("local attachment writes refuse a symlinked project folder and oversized files", async (t) => {
  const home = privateHome(t);
  const attachments = join(home, "prompt-attachments");
  const outside = join(home, "outside");
  await (await import("node:fs/promises")).mkdir(attachments, { mode: 0o700 });
  await (await import("node:fs/promises")).mkdir(outside, { mode: 0o700 });
  symlinkSync(outside, join(attachments, "project-a"));
  await assert.rejects(saveLocalAttachment(home, "project-a", Buffer.from("x"), ""), /private folder/);
  await assert.rejects(saveLocalAttachment(home, "project-b", Buffer.alloc(MAX_PROMPT_ATTACHMENT_BYTES + 1), ""), /25 MB/);
  assert.deepEqual(readdirSync(outside), []);
});

test("remote upload uses a fixed command and sends project/file data only through stdin", async () => {
  const bytes = Buffer.from([0, 1, 2, 255, 10]);
  const command = remoteAttachmentCommand();
  assert.match(command, /^sh -c /);
  assert.match(REMOTE_ATTACHMENT_RECEIVER, /umask 077/);
  assert.doesNotMatch(command, /project-a|customer secret|photo\.png/);
  let called;
  const remotePath = await uploadRemoteAttachment("devbox", "project-a", bytes, ".png", "Dev box", async (target, commands, options) => {
    called = { target, commands, options };
    const header = options.input.subarray(0, options.input.indexOf(bytes)).toString("utf8").split("\n");
    return { code: 0, stdout: `AYA_ATTACHMENT_PATH=/run/user/501/aya/attachments/${header[0]}/${header[1]}\n`, stderr: "", timedOut: false, spawnError: null };
  });
  assert.match(remotePath, /^\/run\/user\/501\/aya\/attachments\/project-a\/[a-f0-9]{32}\.png$/);
  assert.equal(called.target, "devbox");
  assert.deepEqual(called.commands, [command]);
  assert.equal(Buffer.isBuffer(called.options.input), true);
  const input = called.options.input;
  const header = input.subarray(0, input.indexOf(bytes)).toString("utf8").split("\n");
  const [projectId, filename, size] = header;
  assert.equal(projectId, "project-a");
  assert.match(filename, /^[a-f0-9]{32}\.png$/);
  assert.equal(Number(size), bytes.length);
  assert.deepEqual(input.subarray(input.length - bytes.length), bytes);
  assert.equal(called.options.deadlineMs, 30_000);
});

test("remote upload rejects a path outside its private project folder", async () => {
  await assert.rejects(uploadRemoteAttachment("devbox", "project-a", Buffer.from("x"), ".txt", "Dev box", async (_target, _commands, options) => {
    const header = options.input.toString("utf8").split("\n");
    return { code: 0, stdout: `AYA_ATTACHMENT_PATH=/tmp/${header[1]}\n`, stderr: "", timedOut: false, spawnError: null };
  }), /could not confirm the file was copied/);
});

test("the fixed remote receiver refuses a symlinked project folder", (t) => {
  const home = privateHome(t);
  const runtime = join(home, "runtime");
  const attachments = join(runtime, "aya", "attachments");
  const outside = join(home, "outside");
  mkdirSync(attachments, { recursive: true, mode: 0o700 });
  mkdirSync(outside, { mode: 0o700 });
  symlinkSync(outside, join(attachments, "project-a"));
  const filename = `${"a".repeat(32)}.txt`;
  const input = Buffer.from(`project-a\n${filename}\n4\ndata`);
  const result = spawnSync("sh", ["-c", REMOTE_ATTACHMENT_RECEIVER], {
    input,
    env: { ...process.env, HOME: home, XDG_RUNTIME_DIR: runtime },
  });
  assert.notEqual(result.status, 0);
  assert.deepEqual(readdirSync(outside), []);
});

test("remote upload errors are plain and a timeout or password never produces a path", async () => {
  const bytes = Buffer.from("data");
  await assert.rejects(uploadRemoteAttachment("host", "project", bytes, "", "Build host", async () => ({
    code: null, stdout: "", stderr: "", timedOut: true, spawnError: null,
  })), /Build host: the connection took too long.*Nothing was typed/);
  await assert.rejects(uploadRemoteAttachment("host", "project", bytes, "", "Build host", async () => ({
    code: 255, stdout: "", stderr: "Permission denied (publickey,password)", timedOut: false, spawnError: null,
  })), /Build host: it needs a password.*Copy it yourself or set up key login.*Nothing was typed/);
  await assert.rejects(uploadRemoteAttachment("host", "project", bytes, "", "Build host", async () => ({
    code: 255, stdout: "", stderr: "Host key verification failed.", timedOut: false, spawnError: null,
  })), /Build host because SSH needs host approval.*Nothing was typed/);
  let invoked = false;
  await assert.rejects(uploadRemoteAttachment("host", "project", Buffer.alloc(MAX_PROMPT_ATTACHMENT_BYTES + 1), "", "Build host", async () => {
    invoked = true;
    throw new Error("oversized upload reached SSH");
  }), /25 MB limit/);
  assert.equal(invoked, false);
});

test("an approval hold refuses before local or remote copy and typing", async () => {
  const handlers = new Map();
  let uploadCalls = 0;
  const writes = [];
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from("image") }) },
    ayaHome: "/unused",
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => "shows an approval prompt",
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async () => { uploadCalls += 1; throw new Error("copy must not run while held"); },
  });
  await assert.rejects(handlers.get("prompt-attachments:drop")({}, "pane-1", [{ name: "secret.txt", bytes: new Uint8Array([1]) }]), /Not sent: Reviewer is waiting for your answer.*Nothing was typed/);
  assert.equal(uploadCalls, 0);
  assert.deepEqual(writes, []);
});

test("remote authentication failure is shown plainly and never reaches the pane writer", async () => {
  const handlers = new Map();
  const writes = [];
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from("image") }) },
    ayaHome: "/unused",
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async () => { throw new Error("Aya could not copy the file to Build host: it needs a password. Copy it yourself or set up key login. Nothing was typed."); },
  });
  await assert.rejects(handlers.get("prompt-attachments:drop")({}, "pane-1", [{ name: "secret.txt", bytes: new Uint8Array([1]) }]), /needs a password.*Nothing was typed/);
  assert.deepEqual(writes, []);
});
