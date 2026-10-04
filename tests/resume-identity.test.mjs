// A restored pane comes back to ITS OWN conversation or starts fresh, never to a sibling pane's. Each cell
// resolves the command as the CLI does (codex 0.158.0: `resume --last` = newest session of the physical cwd).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resumeSpawn } from "../dist-test/agentPreset.js";
import { sharesFolder } from "../dist-electron/agent-session.js";
import { ownSessionCommand } from "../dist-electron/opencode-session.js";

const root = realpathSync(mkdtempSync(path.join(tmpdir(), "resume-id-")));
const dir = (name) => {
  const p = path.join(root, name);
  mkdirSync(p, { recursive: true });
  return p;
};
const A = dir("a");
const B = dir("wt-b");
const INNER = dir("a/inner");
const LINK = path.join(root, "link-a");
symlinkSync(A, LINK);

// Each topology: the two panes' cwd as Aya holds it.
const TOPOLOGIES = {
  "same dir": [A, A],
  "sibling worktree": [A, B],
  "nested project": [A, INNER],
  "symlinked path": [LINK, LINK],
  "two spellings": [LINK, A],
};
const CLIS = ["claude", "codex", "grok", "opencode"];

const newest = (sessions, dirOrNull) =>
  sessions
    .filter((s) => dirOrNull === null || s.dir === dirOrNull)
    .sort((a, b) => b.updated - a.updated)[0]?.id ?? null;

// What the CLI ends up in for a command: a session id, or null for a fresh one.
async function resolve(cli, command, cwd, sessions) {
  const phys = realpathSync(cwd);
  const tokens = command.split(/\s+/).slice(1);
  const after = (flag) => tokens[tokens.indexOf(flag) + 1];
  switch (cli) {
    case "claude":
      if (tokens.includes("--resume")) return after("--resume");
      return tokens.includes("--continue") ? newest(sessions, phys) : null;
    case "codex":
      if (tokens[0] !== "resume") return null;
      return tokens[1] === "--last" ? newest(sessions, phys) : tokens[1];
    case "grok":
      if (tokens.includes("--resume")) return after("--resume");
      return tokens.includes("--continue") ? newest(sessions, phys) : null;
    case "opencode": {
      const swapped = await ownSessionCommand(command, phys, async () =>
        sessions.map((s) => ({ id: s.id, directory: s.dir, updated: s.updated })),
      );
      const t = swapped.split(/\s+/).slice(1);
      if (t.includes("--session")) return t[t.indexOf("--session") + 1];
      return t.includes("--continue") ? newest(sessions, null) : null;
    }
  }
}

// The renderer's two commands, then the host's choice between them.
async function resumeCommands(cli, cwds, idsKnown, sessions) {
  const preset = { id: cli, name: cli, icon: "", color: "", agent: cli, command: cli };
  const panes = cwds.map((cwd, i) => ({ id: `p${i}`, preset, cwd }));
  return Promise.all(
    panes.map(async (pane, i) => {
      const self = { id: pane.id, cwd: pane.cwd, restored: true, sessionId: idsKnown ? sessions[i].id : undefined };
      const spawn = resumeSpawn(preset, self, panes);
      const shared = spawn.sharedDirCommand && (await sharesFolder(pane.cwd, spawn.peerCwds ?? []));
      return shared ? spawn.sharedDirCommand : spawn.command;
    }),
  );
}

for (const cli of CLIS) {
  for (const panes of [1, 2]) {
    for (const idsKnown of [true, false]) {
      for (const [topology, cwds] of Object.entries(TOPOLOGIES)) {
        const usedCwds = cwds.slice(0, panes);
        const name = `${cli}: ${panes} pane(s), id ${idsKnown ? "known" : "unknown"}, ${topology}`;
        const sharedDir = panes === 2 && realpathSync(usedCwds[0]) === realpathSync(usedCwds[1]);
        test(name, async () => {
          const sessions = usedCwds.map((cwd, i) => ({
            id: `S${i + 1}`,
            dir: realpathSync(cwd),
            updated: 100 * (i + 1),
          }));
          const commands = await resumeCommands(cli, usedCwds, idsKnown, sessions);
          for (const [i, command] of commands.entries()) {
            const got = await resolve(cli, command, usedCwds[i], sessions);
            const own = sessions[i].id;
            const where = `pane ${i + 1} ran "${command}"`;
            if (idsKnown) assert.equal(got, own, where);
            else if (sharedDir) assert.ok(got === own || got === null, `${where} resumed ${got}, a sibling's`);
            else if (cli === "grok") assert.equal(got, null, where);
            else assert.equal(got, own, where);
          }
        });
      }
    }
  }
}
