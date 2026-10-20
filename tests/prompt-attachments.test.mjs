import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  MAX_PROMPT_ATTACHMENT_BYTES,
  PROMPT_ATTACHMENT_RETENTION_MS,
  REMOTE_ATTACHMENT_RECEIVER,
  attachmentPathsInput,
  attachmentFilename,
  remoteAttachmentCommand,
  readDroppedFile,
  safeAttachmentExtension,
  saveLocalAttachment,
  uploadRemoteAttachment,
} from "../dist-electron/prompt-attachments.js";
import { registerPromptAttachmentIpc } from "../dist-electron/ipc/prompt-attachments-ipc.js";
import { notePaneInput, withPaneInputLock } from "../dist-electron/pane-input-queue.js";

function privateHome(t) {
  const home = mkdtempSync(join(tmpdir(), "aya-prompt-attachment-test-"));
  chmodSync(home, 0o700);
  t.after(() => rmSync(home, { recursive: true, force: true }));
  return home;
}

const ipcSender = { mainFrame: {} };
const ipcEvent = { sender: ipcSender, senderFrame: ipcSender.mainFrame };
const ipcWindow = { isDestroyed: () => false, isFocused: () => true };
const trustedWindow = (event) => event.sender === ipcSender ? ipcWindow : null;
async function invokeDrop(handlers, terminalId, files, event = ipcEvent) {
  const token = await handlers.get("prompt-attachments:register-drop")(event, terminalId, files);
  return handlers.get("prompt-attachments:drop")(event, token);
}
async function invokeClipboardImage(handlers, terminalId, event = ipcEvent) {
  const token = await handlers.get("prompt-attachments:register-paste")(event, terminalId);
  return handlers.get("prompt-attachments:clipboard-image")(event, token);
}

test("attachment names are random and retain only a safe extension", () => {
  const extension = safeAttachmentExtension("../../secret name.$(touch pwn).PNG", "image/png");
  assert.equal(extension, ".png");
  const filename = attachmentFilename(extension);
  assert.match(filename, /^[a-f0-9]{32}-attachment\.png$/);
  assert.doesNotMatch(filename, /secret|touch|\.\./);
  assert.equal(safeAttachmentExtension("notes.$(bad);txt"), "");
});

test("attachment paths are shell-quoted, space separated and never contain line breaks", () => {
  assert.equal(attachmentPathsInput(["/tmp/a b.txt", "/tmp/it's.png"]), " '/tmp/a b.txt' '/tmp/it'\\''s.png' ");
  assert.throws(() => attachmentPathsInput(["/tmp/bad\npath"]), /path safely/);
});

test("clipboard image files use private per-project folders and cleanup files older than seven days", async (t) => {
  const home = privateHome(t);
  const first = await saveLocalAttachment(home, "project-a", Buffer.from("image"), ".png");
  const directory = join(home, "prompt-attachments", "project-a");
  assert.equal(lstatSync(join(home, "prompt-attachments")).mode & 0o777, 0o700);
  assert.equal(lstatSync(directory).mode & 0o777, 0o700);
  assert.equal(lstatSync(first).mode & 0o777, 0o600);
  assert.equal(existsSync(first), true);

  const old = join(directory, "old.txt");
  await (await import("node:fs/promises")).writeFile(old, "old", { mode: 0o600 });
  assert.equal(existsSync(old), true);
  // Leave margin for filesystems that round timestamps to whole seconds.
  // Use an unambiguous fixed past timestamp rather than deriving it from the
  // runner clock; CI clocks can be adjusted while the suite is running.
  const oldDate = new Date("2000-01-01T00:00:00.000Z");
  utimesSync(old, oldDate, oldDate);
  assert.ok(Date.now() - lstatSync(old).mtimeMs > PROMPT_ATTACHMENT_RETENTION_MS);
  await saveLocalAttachment(home, "project-a", Buffer.from("next"), ".txt");
  assert.equal(existsSync(old), false);
  assert.equal(readdirSync(directory).length, 2);
});

test("a local dropped file is read only when needed for remote copying", async (t) => {
  const home = privateHome(t);
  const file = join(home, "quarterly report.txt");
  writeFileSync(file, "real source bytes");
  assert.deepEqual(await readDroppedFile(file), { bytes: Buffer.from("real source bytes"), name: "quarterly report.txt" });
  const link = join(home, "linked.txt");
  symlinkSync(file, link);
  await assert.rejects(readDroppedFile(link));
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
  }, "customer secret/photo.png");
  assert.match(remotePath, /^\/run\/user\/501\/aya\/attachments\/project-a\/[a-f0-9]{32}-photo\.png$/);
  assert.equal(called.target, "devbox");
  assert.deepEqual(called.commands, [command]);
  assert.equal(Buffer.isBuffer(called.options.input), true);
  const input = called.options.input;
  const header = input.subarray(0, input.indexOf(bytes)).toString("utf8").split("\n");
  const [projectId, filename, size] = header;
  assert.equal(projectId, "project-a");
  assert.match(filename, /^[a-f0-9]{32}-photo\.png$/);
  assert.doesNotMatch(called.commands[0], /customer secret|photo\.png/);
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
  const filename = `${"a".repeat(32)}-file.txt`;
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

test("an approval hold refuses before local or remote copy and typing", async (t) => {
  const home = privateHome(t);
  const source = join(home, "secret.txt");
  writeFileSync(source, "secret");
  const handlers = new Map();
  let uploadCalls = 0;
  const writes = [];
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from("image") }) },
    ayaHome: "/unused",
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => "shows an approval prompt",
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async () => { uploadCalls += 1; throw new Error("copy must not run while held"); },
  });
  await assert.rejects(invokeDrop(handlers, "pane-1", [{ name: "secret.txt", path: source }]), /Not sent: Reviewer is waiting for your answer.*Nothing was typed/);
  assert.equal(uploadCalls, 0);
  assert.deepEqual(writes, []);
});

test("remote authentication failure is shown plainly and never reaches the pane writer", async (t) => {
  const home = privateHome(t);
  const source = join(home, "secret.txt");
  writeFileSync(source, "secret");
  const handlers = new Map();
  const writes = [];
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from("image") }) },
    ayaHome: "/unused",
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async () => { throw new Error("Aya could not copy the file to Build host: it needs a password. Copy it yourself or set up key login. Nothing was typed."); },
  });
  await assert.rejects(invokeDrop(handlers, "pane-1", [{ name: "secret.txt", path: source }]), /needs a password.*Nothing was typed/);
  assert.deepEqual(writes, []);
});

test("attachment IPC rejects untrusted senders and raw paths without a one-use gesture", async () => {
  const handlers = new Map();
  let clipboardReads = 0;
  let writes = 0;
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => { clipboardReads += 1; return ""; }, readImage: () => { clipboardReads += 1; return { isEmpty: () => false, toPNG: () => Buffer.from("secret") }; } },
    ayaHome: "/unused",
    listProjects: async () => [{ slug: "project-a", tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async () => { writes += 1; return true; },
  });
  const otherSender = { sender: { mainFrame: {} }, senderFrame: {} };
  const childFrame = { sender: ipcSender, senderFrame: {} };
  await assert.rejects(handlers.get("prompt-attachments:register-drop")(otherSender, "pane-1", [{ name: "key", path: "/Users/test/.ssh/id_ed25519" }]));
  await assert.rejects(handlers.get("prompt-attachments:register-paste")(otherSender, "pane-1"));
  await assert.rejects(handlers.get("prompt-attachments:register-drop")(childFrame, "pane-1", [{ name: "key", path: "/Users/test/.ssh/id_ed25519" }]));
  await assert.rejects(handlers.get("prompt-attachments:drop")(ipcEvent, "/Users/test/.ssh/id_ed25519", [{ name: "key", path: "/Users/test/.ssh/id_ed25519" }]));
  await assert.rejects(handlers.get("prompt-attachments:clipboard-image")(ipcEvent, "pane-1"));
  assert.equal(clipboardReads, 0);
  assert.equal(writes, 0);
});

test("drop tokens are bound to their renderer and consumed only once", async (t) => {
  const home = privateHome(t);
  const source = join(home, "selected.txt");
  writeFileSync(source, "selected bytes");
  const handlers = new Map();
  const writes = [];
  let authorizedWindow = ipcWindow;
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow: (event) => event.sender === ipcSender ? authorizedWindow : null,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", tabs: [{ id: "pane-1", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (id, data) => { writes.push([id, data]); return true; },
  });
  const token = await handlers.get("prompt-attachments:register-drop")(ipcEvent, "pane-1", [{ name: "selected.txt", path: source }]);
  await assert.rejects(handlers.get("prompt-attachments:drop")({ sender: { mainFrame: {} }, senderFrame: {} }, token));
  authorizedWindow = { isDestroyed: () => false, isFocused: () => true };
  await assert.rejects(handlers.get("prompt-attachments:drop")(ipcEvent, token));
  authorizedWindow = ipcWindow;
  assert.deepEqual(await handlers.get("prompt-attachments:drop")(ipcEvent, token), { status: "added" });
  await assert.rejects(handlers.get("prompt-attachments:drop")(ipcEvent, token));
  assert.equal(writes.length, 1);
  assert.match(writes[0][1], /selected\.txt/);
});

test("local drops type the original path and do not copy it into Aya home", async (t) => {
  const home = privateHome(t);
  const source = join(home, "quarterly report.txt");
  writeFileSync(source, "real bytes");
  const handlers = new Map();
  const writes = [];
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: join(home, "aya"),
    listProjects: async () => [{ slug: "project-a", tabs: [{ id: "pane-local", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (_id, data) => { writes.push(data); return true; },
  });
  const result = await invokeDrop(handlers, "pane-local", [{ name: "quarterly report.txt", mimeType: "text/plain", path: source }]);
  assert.deepEqual(result, { status: "added" });
  assert.equal(writes.join(""), ` '${source}' `);
  assert.equal(existsSync(join(home, "aya", "prompt-attachments")), false);
});

test("a delayed remote copy is kept for Copy path when pane input changes before delivery", async (t) => {
  const home = privateHome(t);
  const source = join(home, "report.txt");
  writeFileSync(source, "report bytes");
  const handlers = new Map();
  const writes = [];
  let began;
  const uploadBegan = new Promise((resolve) => { began = resolve; });
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-delay", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async (_target, _project, _bytes, _extension, _host, _runner, originalName) => {
      began();
      await delayed;
      return `/run/user/501/aya/attachments/project-a/${"a".repeat(32)}-${originalName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
    },
  });
  const pending = invokeDrop(handlers, "pane-delay", [{ name: "report.txt", mimeType: "text/plain", path: source }]);
  await uploadBegan;
  await withPaneInputLock("pane-delay", async () => notePaneInput("pane-delay"));
  release();
  const result = await pending;
  assert.equal(result.status, "copied-not-added");
  assert.match(result.message, /File copied to Build host but not added, because you typed in the pane meanwhile/);
  assert.match(result.copyText, /\/run\/user\/501\/aya\/attachments\/project-a/);
  assert.deepEqual(writes, []);
});

test("pane input arriving during the final hold check still blocks remote path typing", async (t) => {
  const home = privateHome(t);
  const source = join(home, "report.txt");
  writeFileSync(source, "report bytes");
  const handlers = new Map();
  const writes = [];
  let holdCalls = 0;
  let finishHold;
  const checkingHold = new Promise((resolve) => { finishHold = resolve; });
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-hold-race", name: "Reviewer" }] }],
    holdReason: async () => {
      holdCalls += 1;
      if (holdCalls === 2) return checkingHold;
      return null;
    },
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async () => `/run/user/501/aya/attachments/project-a/${"c".repeat(32)}-report.txt`,
  });
  const pending = invokeDrop(handlers, "pane-hold-race", [{ name: "report.txt", path: source }]);
  while (holdCalls < 2) await new Promise((resolve) => setImmediate(resolve));
  // pty:write marks input intent as soon as its IPC arrives, before it queues
  // behind this attachment's per-pane write lock.
  notePaneInput("pane-hold-race");
  finishHold(null);
  const result = await pending;
  assert.equal(result.status, "copied-not-added");
  assert.match(result.message, /typed in the pane meanwhile/);
  assert.deepEqual(writes, []);
});

test("clipboard image reports its saved path when pane input changes before typing", async (t) => {
  const home = privateHome(t);
  const handlers = new Map();
  const writes = [];
  let holdCalls = 0;
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => false, toPNG: () => Buffer.from("clipboard image") }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", tabs: [{ id: "pane-image-race", name: "Reviewer" }] }],
    holdReason: async () => {
      holdCalls += 1;
      if (holdCalls === 2) notePaneInput("pane-image-race");
      return null;
    },
    writePane: async (_id, data) => { writes.push(data); return true; },
  });
  const result = await invokeClipboardImage(handlers, "pane-image-race");
  assert.equal(result.status, "copied-not-added");
  assert.match(result.message, /Image saved but not added, because you typed in the pane meanwhile/);
  assert.match(result.copyText, /prompt-attachments\/project-a\/[a-f0-9]{32}-attachment\.png/);
  assert.deepEqual(writes, []);
});

test("a later remote upload failure removes earlier copies and sends no path", async (t) => {
  const home = privateHome(t);
  const first = join(home, "one.txt");
  const second = join(home, "two.txt");
  writeFileSync(first, "one");
  writeFileSync(second, "two");
  const handlers = new Map();
  const writes = [];
  const cleaned = [];
  let uploadCount = 0;
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-partial", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async (_id, data) => { writes.push(data); return true; },
    upload: async (_target, _project, _bytes, _extension, _host, _runner, originalName) => {
      uploadCount += 1;
      if (uploadCount === 2) throw new Error("Aya could not copy the file to Build host: it needs a password. Nothing was typed.");
      return `/run/user/501/aya/attachments/project-a/${"b".repeat(32)}-${originalName}`;
    },
    cleanup: async (_target, _project, names) => { cleaned.push(...names); },
  });
  await assert.rejects(invokeDrop(handlers, "pane-partial", [
    { name: "one.txt", path: first },
    { name: "two.txt", path: second },
  ]), /needs a password/);
  assert.deepEqual(cleaned, [`${"b".repeat(32)}-one.txt`]);
  assert.deepEqual(writes, []);
});

test("a remote batch whose final pane write fails removes every uploaded copy", async (t) => {
  const home = privateHome(t);
  const first = join(home, "one.txt");
  const second = join(home, "two.txt");
  writeFileSync(first, "one");
  writeFileSync(second, "two");
  const handlers = new Map();
  const cleaned = [];
  let uploadCount = 0;
  registerPromptAttachmentIpc({
    ipcMain: { handle: (name, handler) => handlers.set(name, handler) },
    trustedWindow,
    clipboard: { readText: () => "", readImage: () => ({ isEmpty: () => true, toPNG: () => Buffer.alloc(0) }) },
    ayaHome: home,
    listProjects: async () => [{ slug: "project-a", remote: { label: "Build host", sshTarget: "devbox" }, tabs: [{ id: "pane-write-fails", name: "Reviewer" }] }],
    holdReason: async () => null,
    writePane: async () => false,
    upload: async (_target, _project, _bytes, _extension, _host, _runner, originalName) => {
      uploadCount += 1;
      return `/run/user/501/aya/attachments/project-a/${String(uploadCount).padStart(32, "b")}-${originalName}`;
    },
    cleanup: async (_target, _project, names) => { cleaned.push(...names); },
  });
  await assert.rejects(invokeDrop(handlers, "pane-write-fails", [
    { name: "one.txt", path: first },
    { name: "two.txt", path: second },
  ]), /Aya could not add the file to the prompt.*Nothing was typed/);
  assert.deepEqual(cleaned, [`${"1".padStart(32, "b")}-one.txt`, `${"2".padStart(32, "b")}-two.txt`]);
});
