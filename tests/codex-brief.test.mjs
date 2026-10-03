// Codex gets the brief at launch (developer_instructions); the AGENTS.md files earlier
// versions wrote it into lose their section once. rewriteIfChanged edits such a file in place.

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { rewriteIfChanged, dropCodexBriefSections } = await import("../dist-electron/codex-brief.js");
const { withBriefSection, BRIEF_BEGIN, BRIEF_END, briefText } = await import("../dist-electron/agent-brief.js");

const SECTION = withBriefSection("", briefText(true));
const has = (file) => existsSync(file) && readFileSync(file, "utf8").includes(BRIEF_BEGIN);

test("upgrade: every recorded AGENTS.md loses Aya's section, the user's text stays, and the list goes", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aya-drop-")));
  const registry = join(dir, "agent-brief-files.json");
  writeFileSync(join(dir, "a.md"), `mine\n\n${SECTION}`);
  writeFileSync(join(dir, "b.md"), SECTION);
  writeFileSync(join(dir, "unrecorded.md"), `theirs\n\n${SECTION}`);
  writeFileSync(registry, JSON.stringify([join(dir, "a.md"), join(dir, "b.md"), join(dir, "gone.md")]));
  await dropCodexBriefSections(registry);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "mine\n");
  assert.equal(existsSync(join(dir, "b.md")), false, "a file that held only the section goes");
  assert.equal(has(join(dir, "unrecorded.md")), true, "a file Aya never recorded is not touched");
  assert.equal(existsSync(join(dir, "gone.md")), false, "a missing file is not created");
  assert.equal(existsSync(registry), false);
  rmSync(dir, { recursive: true, force: true });
});

test("upgrade: no list, an unreadable list, or a file that cannot be rewritten leaves the list for the next start", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "aya-drop-")));
  const registry = join(dir, "agent-brief-files.json");
  await dropCodexBriefSections(registry);
  assert.equal(existsSync(registry), false);
  writeFileSync(registry, "{not json");
  await dropCodexBriefSections(registry);
  assert.equal(readFileSync(registry, "utf8"), "{not json");
  writeFileSync(registry, "{}");
  await dropCodexBriefSections(registry);
  assert.equal(readFileSync(registry, "utf8"), "{}", "a list that is not a list is unreadable too");
  writeFileSync(registry, JSON.stringify([join(dir, "a.md")]));
  const warn = console.warn;
  console.warn = () => {};
  try {
    await dropCodexBriefSections(registry, async () => {
      throw new Error("read-only");
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(existsSync(registry), true);
  rmSync(dir, { recursive: true, force: true });
});

test("the brief text both CLIs get names no CLI", () => {
  for (const conditional of [true, false]) assert.doesNotMatch(briefText(conditional), /codex|opencode|claude|grok/i);
});

// rewriteIfChanged on its own: a link's target is edited in place, a damaged file is left alone.
const scratch = () => realpathSync(mkdtempSync(join(tmpdir(), "aya-rewrite-")));
const isLink = (f) => lstatSync(f).isSymbolicLink();

test("rewriteIfChanged edits a symlinked AGENTS.md at its target and keeps the link", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "dotfiles-AGENTS.md"), "mine\n");
  symlinkSync(join(dir, "dotfiles-AGENTS.md"), join(dir, "AGENTS.md"));
  await rewriteIfChanged(join(dir, "AGENTS.md"), (c) => withBriefSection(c, briefText(true)));
  assert.equal(isLink(join(dir, "AGENTS.md")), true, "still a link");
  assert.equal(has(join(dir, "dotfiles-AGENTS.md")), true, "the target has the section");
  assert.match(readFileSync(join(dir, "dotfiles-AGENTS.md"), "utf8"), /^mine\n/);
  await rewriteIfChanged(join(dir, "AGENTS.md"), (c) => c.replace(/mine\n/, ""));
  assert.equal(isLink(join(dir, "AGENTS.md")), true);
  rmSync(dir, { recursive: true, force: true });
});

test("rewriteIfChanged: a file that held only the section goes, but a link's target is emptied, not removed", async () => {
  const dir = scratch();
  writeFileSync(join(dir, "AGENTS.md"), SECTION);
  await rewriteIfChanged(join(dir, "AGENTS.md"), () => "");
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);
  writeFileSync(join(dir, "target.md"), SECTION);
  symlinkSync(join(dir, "target.md"), join(dir, "link.md"));
  await rewriteIfChanged(join(dir, "link.md"), () => "");
  assert.equal(isLink(join(dir, "link.md")), true, "the link is still there");
  assert.equal(readFileSync(join(dir, "target.md"), "utf8"), "", "the target is empty");
  rmSync(dir, { recursive: true, force: true });
});

test("rewriteIfChanged leaves a file with damaged brief markers untouched and says why", async () => {
  const dir = scratch();
  const damaged = `mine\n${BRIEF_BEGIN}\nhalf a section, no end marker\n`;
  writeFileSync(join(dir, "AGENTS.md"), damaged);
  const warned = [];
  const warn = console.warn;
  console.warn = (...a) => warned.push(a.join(" "));
  try {
    await rewriteIfChanged(join(dir, "AGENTS.md"), (c) => `${c}changed\n`);
  } finally {
    console.warn = warn;
  }
  assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), damaged);
  assert.equal(warned.length, 1);
  assert.match(warned[0], /brief markers are damaged/);
  rmSync(dir, { recursive: true, force: true });
});

test("rewriteIfChanged creates a missing file and writes nothing when the change is a no-op", async () => {
  const dir = scratch();
  await rewriteIfChanged(join(dir, "AGENTS.md"), (c) => withBriefSection(c, briefText(true)));
  assert.equal(has(join(dir, "AGENTS.md")), true);
  const before = statSync(join(dir, "AGENTS.md")).mtimeMs;
  await new Promise((r) => setTimeout(r, 20));
  await rewriteIfChanged(join(dir, "AGENTS.md"), (c) => c);
  assert.equal(statSync(join(dir, "AGENTS.md")).mtimeMs, before);
  await rewriteIfChanged(join(dir, "none.md"), (c) => c);
  assert.equal(existsSync(join(dir, "none.md")), false);
  rmSync(dir, { recursive: true, force: true });
});

test("a file with an end marker and no begin has no section of ours to damage: it is edited", async () => {
  const dir = scratch();
  const file = join(dir, "AGENTS.md");
  writeFileSync(file, `notes\n${BRIEF_END}\n`);
  await rewriteIfChanged(file, (content) => `${content}more\n`);
  assert.match(readFileSync(file, "utf8"), /more\n$/);
  rmSync(dir, { recursive: true, force: true });
});
