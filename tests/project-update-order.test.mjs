// Two session ids arriving together make two project saves; the file must end
// as the last one asked for, or a pane loses the id it just learned.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

test("updateProject: saves fired together land in the order they were asked for", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-update-project-"));
  try {
    await run(
      process.execPath,
      [
        "-e",
        `
          const { updateProject } = require("./dist-electron/config.js");
          const save = (n) => updateProject({
            slug: "p", name: "p", directory: "/tmp/p", tabs: [{ id: "t", presetId: "x", name: "t", sessionId: "s" + n }],
          });
          Promise.all(Array.from({ length: 1500 }, (_, n) => save(n))).catch((err) => { console.error(err); process.exit(1); });
        `,
      ],
      { cwd: process.cwd(), env: { ...process.env, AYA_HOME: dir } },
    );
    const saved = JSON.parse(await readFile(path.join(dir, "projects", "p.json"), "utf8"));
    assert.equal(saved.tabs[0].sessionId, "s1499");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateProject: a save that fails does not stop the ones after it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-update-project-"));
  try {
    await run(
      process.execPath,
      [
        "-e",
        `
          const { updateProject } = require("./dist-electron/config.js");
          const tab = { id: "t", presetId: "x", name: "t", sessionId: "ok" };
          const circular = { id: "t", presetId: "x", name: "t" };
          circular.self = circular;
          const bad = updateProject({ slug: "p", name: "p", directory: "/tmp/p", tabs: [circular] });
          const good = updateProject({ slug: "p", name: "p", directory: "/tmp/p", tabs: [tab] });
          Promise.allSettled([bad, good]).then(([b, g]) => {
            if (b.status !== "rejected" || g.status !== "fulfilled") { console.error(b.status, g.status); process.exit(1); }
          });
        `,
      ],
      { cwd: process.cwd(), env: { ...process.env, AYA_HOME: dir } },
    );
    const saved = JSON.parse(await readFile(path.join(dir, "projects", "p.json"), "utf8"));
    assert.equal(saved.tabs[0].sessionId, "ok");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("updateProjectFromLatest merges an additive tab after a concurrent saved project change", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "aya-update-project-latest-"));
  try {
    await run(
      process.execPath,
      [
        "-e",
        `
          const { createProject, listProjects, updateProject, updateProjectFromLatest } = require("./dist-electron/config.js");
          (async () => {
            await createProject("p", "/tmp/p");
            const stale = (await listProjects())[0];
            const local = { id: "local", presetId: "shell", name: "Local" };
            const remote = { id: "remote", presetId: "shell", name: "Remote" };
            const localSave = updateProject({ ...stale, name: "Renamed locally", tabs: [local] });
            const remoteSave = updateProjectFromLatest("p", (current) => ({ ...current, tabs: [...current.tabs, remote] }));
            await Promise.all([localSave, remoteSave]);
          })().catch((err) => { console.error(err); process.exit(1); });
        `,
      ],
      { cwd: process.cwd(), env: { ...process.env, AYA_HOME: dir } },
    );
    const saved = JSON.parse(await readFile(path.join(dir, "projects", "p.json"), "utf8"));
    assert.equal(saved.name, "Renamed locally");
    assert.deepEqual(saved.tabs.map((tab) => tab.id), ["local", "remote"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
