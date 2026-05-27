import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readRepoProjectConfig } from "../dist-electron/project-local.js";

test("reads valid repo-local preset suggestions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aya-project-local-"));
  await mkdir(join(dir, ".aya"));
  await writeFile(
    join(dir, ".aya", "project.json"),
    JSON.stringify({
      presets: [
        {
          id: "dev-server",
          name: "Dev server",
          icon: "D",
          color: "#56d364",
          command: "npm run dev",
        },
        {
          id: "bad",
          name: "Bad",
        },
      ],
    }),
  );

  const config = await readRepoProjectConfig(dir);
  assert.deepEqual(config, {
    presets: [
      {
        id: "dev-server",
        name: "Dev server",
        icon: "D",
        color: "#56d364",
        command: "npm run dev",
      },
    ],
  });
});

test("returns null when repo-local config has no valid presets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "aya-project-local-empty-"));
  await mkdir(join(dir, ".aya"));
  await writeFile(join(dir, ".aya", "project.json"), JSON.stringify({ presets: [] }));

  assert.equal(await readRepoProjectConfig(dir), null);
});
