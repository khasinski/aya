// Opening an existing (remote) project must not fail. The remote "open project"
// flow sends project:create even for a project that already exists, so the
// create path has to be idempotent. Regression test for: new remote project is
// created, but an existing one couldn't be opened ("Project already exists").
//
// AYA_HOME is redirected to a temp dir BEFORE the (dynamic) config import so
// paths.ts resolves against the throwaway home; node --test isolates per file.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AYA_HOME = mkdtempSync(join(tmpdir(), "aya-remote-open-"));
const { createProject, getOrCreateProject, createRemoteProject } = await import(
  "../dist-electron/config.js"
);

test("getOrCreateProject returns the existing project on re-open (createProject would throw)", async () => {
  const dir = "/srv/work/alpha";
  const first = await getOrCreateProject("Alpha", dir);
  // createProject is strict: a second create for the same slug fails.
  await assert.rejects(() => createProject("Alpha", dir), /already exists/);
  // getOrCreateProject instead returns the same project — the open succeeds.
  const second = await getOrCreateProject("Alpha", dir);
  assert.equal(second.slug, first.slug);
  assert.equal(second.directory, first.directory);
});

test("createRemoteProject re-add returns the existing record for the same host+dir", async () => {
  const req = {
    name: "Repo",
    directory: "/srv/repo",
    hostId: "h1",
    label: "box",
    sshTarget: "user@box",
  };
  const first = await createRemoteProject(req);
  const again = await createRemoteProject(req);
  assert.equal(again.slug, first.slug);
  assert.deepEqual(again.remote, first.remote);
});

test("createRemoteProject still rejects a genuine slug collision (different directory)", async () => {
  const base = {
    name: "Site",
    directory: "/srv/site",
    hostId: "h1",
    label: "box",
    sshTarget: "user@box",
  };
  await createRemoteProject(base);
  // Same name+label (same slug) but a different directory is a real conflict.
  await assert.rejects(
    () => createRemoteProject({ ...base, directory: "/srv/site-2" }),
    /already exists/,
  );
});
