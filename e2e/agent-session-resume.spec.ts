// Two panes of one CLI in one folder each come back to their own conversation, or start fresh: never
// both to the newest one. The stand-ins in helpers/ keep the CLIs' session stores, not their UIs.

import { existsSync, mkdirSync, readdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Page } from "@playwright/test";
import { AGENT_SESSION_POLL_MS } from "../dist-electron/agent-session.js";
import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { launchApp } from "./helpers/relaunch";
import { IMPLEMENTER_FIRST_TEAM, teamSeed } from "./helpers/team";
import { agentBin } from "./helpers/agent-bin";

const FAKE_CODEX = agentBin("codex", join(__dirname, "helpers", "fake-codex.cjs"));
const FAKE_GROK = agentBin("grok", join(__dirname, "helpers", "fake-grok.cjs"));
const FAKE_CLAUDE = agentBin("claude", join(__dirname, "helpers", "fake-claude.cjs"));
// claude and grok take only a UUID as --session-id; any other --resume value is a title.
const PURGED_SESSION = "33333333-3333-4333-8333-333333333333";
const PURGED_CONVERSATION = "44444444-4444-4444-8444-444444444444";
const RC_CONVERSATION = "55555555-5555-4555-8555-555555555555";
const REMOTE_CONVERSATION = "11111111-1111-4111-8111-111111111111";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LONG = { timeout: SLOW_EXPECT_TIMEOUT_MS };
/** Two boots and the panes' agents twice over. */
const RELAUNCH_TEST_TIMEOUT_MS = 150_000;

type Launch = { args: string[]; resumed?: string | null; session: string | null; sessionId?: string; pid: number };

const launches = (projectDir: string, tabId: string): Launch[] => {
  const file = join(projectDir, `agent-${tabId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Launch);
};

const savedSessions = (ayaHome: string) => {
  const state = JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8")) as {
    tabs: { id: string; sessionId?: string }[];
  };
  return Object.fromEntries(state.tabs.map((t) => [t.id, t.sessionId ?? null]));
};

const LEFT = "shell 1";
const RIGHT = "shell 2";
const menu = async (window: Page, name: string, item: string) => {
  await window.locator(`.aya-sidebar-row[data-terminal-name="${name}"]`).click({ button: "right" });
  await window.locator(".aya-context-menu-item", { hasText: item }).click();
};
const restart = (window: Page, name: string) => menu(window, name, "Restart terminal");
const waitLaunches = (dir: string, tab: string, n: number) =>
  expect.poll(() => launches(dir, tab).length, LONG).toBe(n);

/** A restart, then a wait for the relaunch: panes come back one after the other. */
async function restartAndWait(window: Page, dir: string, name: string, tab: string, n: number) {
  await restart(window, name);
  await waitLaunches(dir, tab, n);
}

const command = (env: string, fake: string, home: string) =>
  `${env} ${home} ${fake} "$AYA_PROJECT_DIR/agent-$AYA_TERMINAL_ID.jsonl"`;

/** A preset running `fake` as `agent`, its store under ~/<dir> through `homeVar`; `env` steers the fake. */
const fakePreset = (agent: string, name: string, icon: string, fake: string, homeVar: string, dir: string) => (env: string) => ({
  id: "shell",
  name,
  icon,
  color: "",
  agent,
  autoResume: true,
  configDir: `~/${dir}`,
  command: command(env, fake, `${homeVar}="$HOME/${dir}"`),
});
const codexPreset = fakePreset("codex", "Codex", "c", FAKE_CODEX, "CODEX_HOME", "codex-home");
const grokPreset = fakePreset("grok", "Grok", "g", FAKE_GROK, "GROK_HOME", "grok-home");
const claudePreset = fakePreset("claude", "Claude", "c", FAKE_CLAUDE, "CLAUDE_CONFIG_DIR", "claude-config");
/** Codex with no session store Aya can read, and two earlier conversations in the folder. */
const BLIND_CODEX = codexPreset("FAKE_CODEX_STORE=off FAKE_CODEX_PRIOR=prior-1,prior-2");
const sharedDirs = (ayaHome: string) =>
  Object.fromEntries(
    (JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8")) as { tabs: { id: string; sharedDir?: boolean }[] }).tabs.map((t) => [t.id, t.sharedDir]),
  );

/** A thread the way codex records one: in state and, for the pid, in logs. */
function codexThread(root: string, cwd: string, pid: number, id: string) {
  const home = join(root, "home", "codex-home");
  const now = Date.now();
  const state = new DatabaseSync(join(home, "state_5.sqlite"));
  state.prepare("INSERT INTO threads VALUES (?, ?, 'cli', 'user', ?, ?)").run(id, realpathSync(cwd), now, now);
  state.close();
  const logs = new DatabaseSync(join(home, "logs_2.sqlite"));
  logs.prepare("INSERT INTO logs (ts, thread_id, process_uuid) VALUES (?, ?, ?)").run(Math.floor(now / 1000), id, `pid:${pid}:x`);
  logs.close();
}

test.describe("codex panes that share a folder", () => {
  test.use({ seedOptions: { presetList: [codexPreset("FAKE_CODEX_STORE=on")] } });

  test("each pane learns its own session and resumes it, whichever restarts first", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    for (const tab of tabs) await waitLaunches(projectDir, tab, 1);
    const first = Object.fromEntries(tabs.map((tab) => [tab, launches(projectDir, tab)[0]]));
    expect(first[tabIds.left].args).toEqual([]);
    expect(first[tabIds.right].args).toEqual([]);
    expect(first[tabIds.left].session).not.toBe(first[tabIds.right].session);
    await expect
      .poll(() => savedSessions(ayaHome), LONG)
      .toMatchObject({ [tabIds.left]: first[tabIds.left].session, [tabIds.right]: first[tabIds.right].session });

    // The right pane restarts first, the left one only once it is back.
    await restartAndWait(window, projectDir, RIGHT, tabIds.right, 2);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    for (const tab of tabs) {
      const again = launches(projectDir, tab)[1];
      expect(again.args).toEqual(["resume", first[tab].session]);
      expect(again.resumed).toBe(first[tab].session);
    }
  });

  test("a session started with /new is the one a restart resumes", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds, root } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    const left = launches(projectDir, tabIds.left)[0];
    await expect.poll(() => savedSessions(ayaHome)[tabIds.left], LONG).toBe(left.session);
    codexThread(root, projectDir, left.pid, "thread-after-new");
    await expect.poll(() => savedSessions(ayaHome)[tabIds.left], LONG).toBe("thread-after-new");
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].args).toEqual(["resume", "thread-after-new"]);
  });

  test("closing the sibling leaves the survivor resuming its own session", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    const left = launches(projectDir, tabIds.left)[0];
    const right = launches(projectDir, tabIds.right)[0];
    await expect
      .poll(() => savedSessions(ayaHome), LONG)
      .toMatchObject({ [tabIds.left]: left.session, [tabIds.right]: right.session });
    await menu(window, RIGHT, "Close terminal");
    await expect(window.locator(".aya-sidebar-row", { hasText: RIGHT })).toHaveCount(0);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].args).toEqual(["resume", left.session]);
  });

  test("a real quit and relaunch brings each pane back to its own session", async ({ seeded }) => {
    test.setTimeout(RELAUNCH_TEST_TIMEOUT_MS);
    const { projectDir, ayaHome, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    const first = await launchApp(seeded);
    let second: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      for (const tab of tabs) await waitLaunches(projectDir, tab, 1);
      const born = Object.fromEntries(tabs.map((tab) => [tab, launches(projectDir, tab)[0]]));
      await expect
        .poll(() => savedSessions(ayaHome), LONG)
        .toMatchObject({ [tabIds.left]: born[tabIds.left].session, [tabIds.right]: born[tabIds.right].session });
      await first.app.close();
      second = await launchApp(seeded);
      for (const tab of tabs) await waitLaunches(projectDir, tab, 2);
      for (const tab of tabs) expect(launches(projectDir, tab)[1].args).toEqual(["resume", born[tab].session]);
    } finally {
      await first.app.close().catch(() => undefined);
      await second?.app.close().catch(() => undefined);
    }
  });
});

test.describe("codex panes whose store is of a schema Aya does not know", () => {
  test.use({ seedOptions: { presetList: [codexPreset("FAKE_CODEX_STORE=on")] } });

  test("say so once in the host log and start fresh", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds, root } = seeded;
    const home = join(root, "home", "codex-home");
    mkdirSync(home, { recursive: true });
    const future = new DatabaseSync(join(home, "state_9.sqlite"));
    future.exec("CREATE TABLE threads (id TEXT PRIMARY KEY, cwd TEXT NOT NULL, touched INTEGER)");
    future.close();
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    const failures = () =>
      readFileSync(join(ayaHome, "pty-events.log"), "utf8")
        .split("\n")
        .filter((line) => line.includes("agent-session-read-failed") && line.includes("updated_at_ms"));
    await expect.poll(() => failures().length, LONG).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 2 * AGENT_SESSION_POLL_MS + 1_000));
    expect(failures()).toHaveLength(2);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].args).toEqual([]);
  });
});

test.describe("codex panes Aya cannot read a session from", () => {
  test.use({
    seedOptions: {
      presetList: [BLIND_CODEX],
    },
  });

  test("neither pane resumes the folder's newest conversation", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) {
      await waitLaunches(projectDir, tab, 1);
      expect(launches(projectDir, tab)[0].resumed).toBeNull();
    }
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].resumed).toBeNull();
  });
});

test.describe("codex panes in one folder spelled two ways", () => {
  test.use({
    seedOptions: {
      rightTabViaSymlink: true,
      presetList: [BLIND_CODEX],
    },
  });

  test("count as sharing it: neither resumes the newest conversation", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) {
      await waitLaunches(projectDir, tab, 1);
      expect(launches(projectDir, tab)[0].resumed).toBeNull();
    }
  });
});

test.describe("a codex pane that has always been alone in its folder", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Codex" },
      presetList: [BLIND_CODEX],
    },
  });

  test("still continues the folder's latest conversation", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const only = launches(projectDir, tabIds.left)[0];
    expect(only.args).toEqual(["resume", "--last"]);
    expect(only.resumed).toBe("prior-2");
  });
});

test.describe("a codex pane whose sibling was closed before either learned a session", () => {
  test.use({
    seedOptions: {
      presetList: [BLIND_CODEX],
    },
  });

  test("does not take the closed sibling's conversation as the folder's latest", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    await menu(window, RIGHT, "Close terminal");
    await expect(window.locator(".aya-sidebar-row", { hasText: RIGHT })).toHaveCount(0);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    const again = launches(projectDir, tabIds.left)[1];
    expect(again.args).toEqual([]);
    expect(again.resumed).toBeNull();
  });
});

test.describe("codex panes in one folder", () => {
  test.use({
    seedOptions: {
      presetList: [BLIND_CODEX],
    },
  });

  test("both save the shared-folder latch as soon as they run together", async ({ window, seeded }) => {
    void window;
    const { ayaHome, tabIds } = seeded;
    const latches = () => [sharedDirs(ayaHome)[tabIds.left], sharedDirs(ayaHome)[tabIds.right]];
    await expect.poll(latches, LONG).toEqual([true, true]);
  });
});

test.describe("a codex pane whose sibling was closed, across a quit", () => {
  test.use({
    seedOptions: {
      presetList: [BLIND_CODEX],
    },
  });

  test("the latch is saved: the next life starts fresh", async ({ seeded }) => {
    test.setTimeout(RELAUNCH_TEST_TIMEOUT_MS);
    const { projectDir, ayaHome, tabIds } = seeded;
    const first = await launchApp(seeded);
    let second: Awaited<ReturnType<typeof launchApp>> | undefined;
    try {
      for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
      await menu(first.window, RIGHT, "Close terminal");
      await expect(first.window.locator(".aya-sidebar-row", { hasText: RIGHT })).toHaveCount(0);
      await expect.poll(() => sharedDirs(ayaHome)[tabIds.left], LONG).toBe(true);
      await first.app.close();
      second = await launchApp(seeded);
      await waitLaunches(projectDir, tabIds.left, 2);
      expect(launches(projectDir, tabIds.left)[1].args).toEqual([]);
    } finally {
      await first.app.close().catch(() => undefined);
      await second?.app.close().catch(() => undefined);
    }
  });
});

test.describe("a codex pane that had a sibling opened and closed after it restarted", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "First" },
      presetList: [BLIND_CODEX],
    },
  });

  test("goes back to being fresh, not to whatever the sibling started", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    await restartAndWait(window, projectDir, "First", tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].args).toEqual(["resume", "--last"]);
    await window.locator(".aya-launcher .aya-launcher-btn", { hasText: "Codex" }).click();
    await expect(window.locator('.aya-sidebar-row[data-terminal-name="Codex"]')).toHaveCount(1);
    await menu(window, "Codex", "Close terminal");
    await expect(window.locator('.aya-sidebar-row[data-terminal-name="Codex"]')).toHaveCount(0);
    await restartAndWait(window, projectDir, "First", tabIds.left, 3);
    const last = launches(projectDir, tabIds.left)[2];
    expect(last.args).toEqual([]);
    expect(last.resumed).toBeNull();
  });
});

test.describe("a claude pane alone in its folder that shared it once", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Claude" },
      leftSharedDir: true,
      presetList: [claudePreset("FAKE_CLAUDE_UNSAVED=1")],
    },
  });

  test("starts under an id of its own, not --continue", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const args = launches(projectDir, tabIds.left)[0].args;
    expect(args).not.toContain("--continue");
    expect(argAfter(args, "--session-id")).toMatch(UUID);
  });
});

test.describe("a codex pane whose saved session is gone", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Codex" },
      tabSessionIds: { left: "purged-thread" },
      presetList: [codexPreset("FAKE_CODEX_STORE=on")],
    },
  });

  test("starts fresh instead of dying on `resume <gone>`", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const only = launches(projectDir, tabIds.left)[0];
    expect(only.args).toEqual([]);
    expect(only.session).toBeTruthy();
  });
});

test.describe("grok panes that share a folder", () => {
  test.use({ seedOptions: { presetList: [grokPreset("FAKE_GROK_UNSAVED=0")] } });

  test("each pane has its own id from the start and resumes it", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    for (const tab of tabs) await waitLaunches(projectDir, tab, 1);
    const first = Object.fromEntries(tabs.map((tab) => [tab, launches(projectDir, tab)[0]]));
    for (const tab of tabs) expect(first[tab].args).toEqual(["--session-id", first[tab].session]);
    expect(first[tabIds.left].session).not.toBe(first[tabIds.right].session);
    await expect
      .poll(() => savedSessions(ayaHome), LONG)
      .toMatchObject({ [tabIds.left]: first[tabIds.left].session, [tabIds.right]: first[tabIds.right].session });
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    await restartAndWait(window, projectDir, RIGHT, tabIds.right, 2);
    for (const tab of tabs) expect(launches(projectDir, tab)[1].args).toEqual(["--resume", first[tab].session]);
  });
});

test.describe("grok panes restarted before their first message", () => {
  test.use({ seedOptions: { presetList: [grokPreset("FAKE_GROK_UNSAVED=1")] } });

  test("keep their own id: a new session under it, not a dead resume", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    const left = launches(projectDir, tabIds.left)[0];
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1].args).toEqual(["--session-id", left.session]);
  });
});

test.describe("a grok pane whose saved session is gone", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Grok" },
      tabSessionIds: { left: PURGED_SESSION },
      presetList: [grokPreset("FAKE_GROK_UNSAVED=0")],
    },
  });

  test("starts a new session under the same id instead of dying on --resume", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    expect(launches(projectDir, tabIds.left)[0].args).toEqual(["--session-id", PURGED_SESSION]);
  });
});

test.describe("claude panes restarted before their first message", () => {
  test.use({ seedOptions: { presetList: [claudePreset("FAKE_CLAUDE_UNSAVED=1")] } });

  test("keep the id they were born with, never --continue", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    for (const tab of tabs) await waitLaunches(projectDir, tab, 1);
    const born = Object.fromEntries(
      tabs.map((tab) => [tab, launches(projectDir, tab)[0].args.at(-1) as string]),
    );
    for (const tab of tabs) {
      expect(launches(projectDir, tab)[0].args.at(-2)).toBe("--session-id");
      expect(born[tab]).toMatch(UUID);
    }
    expect(born[tabIds.left]).not.toBe(born[tabIds.right]);
    await expect.poll(() => savedSessions(ayaHome), LONG).toMatchObject(born);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    await restartAndWait(window, projectDir, RIGHT, tabIds.right, 2);
    for (const tab of tabs) expect(launches(projectDir, tab)[1].args).toEqual(["--session-id", born[tab]]);
  });
});

test.describe("claude panes that share a folder and have written their transcripts", () => {
  test.use({ seedOptions: { presetList: [claudePreset("FAKE_CLAUDE_UNSAVED=0")] } });

  test("each resumes its own conversation", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    for (const tab of tabs) await waitLaunches(projectDir, tab, 1);
    const ids = Object.fromEntries(tabs.map((tab) => [tab, launches(projectDir, tab)[0].sessionId as string]));
    await expect.poll(() => savedSessions(ayaHome), LONG).toMatchObject(ids);
    await restartAndWait(window, projectDir, RIGHT, tabIds.right, 2);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    for (const tab of tabs) expect(launches(projectDir, tab)[1].args).toEqual(["--resume", ids[tab]]);
  });
});

// The brief and a team pane's role note ride on the command: the id steps must still see it.
const briefed = (preset: ReturnType<typeof claudePreset>) => ({ ...preset, agentBrief: true });
const argAfter = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

test.describe("claude panes with the brief on, restarted before their first message", () => {
  test.use({ seedOptions: { presetList: [briefed(claudePreset("FAKE_CLAUDE_UNSAVED=1"))] } });

  test("keep the id they were born with, never a dead --resume", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    for (const tab of [tabIds.left, tabIds.right]) await waitLaunches(projectDir, tab, 1);
    const first = launches(projectDir, tabIds.left)[0].args;
    const born = argAfter(first, "--session-id");
    expect(born).toMatch(UUID);
    expect(argAfter(first, "--append-system-prompt")).toContain("aya capabilities");
    await expect.poll(() => savedSessions(ayaHome)[tabIds.left], LONG).toBe(born);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    const again = launches(projectDir, tabIds.left)[1].args;
    expect(again).not.toContain("--resume");
    expect(argAfter(again, "--session-id")).toBe(born);
    expect(argAfter(again, "--append-system-prompt")).toContain("aya capabilities");
  });
});

test.describe("claude team panes (a role note with an apostrophe), restarted before their first message", () => {
  test.use({
    seedOptions: {
      ...teamSeed(IMPLEMENTER_FIRST_TEAM, { presetList: [claudePreset("FAKE_CLAUDE_UNSAVED=1")] }).seedOptions,
    },
  });

  test("are born with an id and come back under it", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const first = launches(projectDir, tabIds.left)[0].args;
    expect(argAfter(first, "--append-system-prompt")).toMatch(/team ux-review/);
    const born = argAfter(first, "--session-id");
    expect(born).toMatch(UUID);
    await expect.poll(() => savedSessions(ayaHome)[tabIds.left], LONG).toBe(born);
    await restartAndWait(window, projectDir, LEFT, tabIds.left, 2);
    const again = launches(projectDir, tabIds.left)[1].args;
    expect(again).not.toContain("--resume");
    expect(argAfter(again, "--session-id")).toBe(born);
  });
});

test.describe("a claude pane with the brief on whose saved conversation is gone", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Claude" },
      tabSessionIds: { left: PURGED_CONVERSATION },
      presetList: [briefed(claudePreset("FAKE_CLAUDE_UNSAVED=0"))],
    },
  });

  test("starts a new conversation under the same id instead of dying on --resume", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const args = launches(projectDir, tabIds.left)[0].args;
    expect(args).not.toContain("--resume");
    expect(argAfter(args, "--session-id")).toBe(PURGED_CONVERSATION);
  });
});

test.describe("a grok pane with the brief on whose saved session is gone", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "Grok" },
      tabSessionIds: { left: PURGED_SESSION },
      presetList: [{ ...grokPreset("FAKE_GROK_UNSAVED=0"), agentBrief: true }],
    },
  });

  test("starts a new session under the same id instead of dying on --resume", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const args = launches(projectDir, tabIds.left)[0].args;
    expect(args).not.toContain("--resume");
    expect(argAfter(args, "--session-id")).toBe(PURGED_SESSION);
    expect(argAfter(args, "--rules")).toContain("aya capabilities");
  });
});

/** One claude pane with a saved conversation, its CLAUDE_CONFIG_DIR set only in the shell's rc files. */
const rcConfigSeed = (preset: { configDir?: string }) => ({
  seedOptions: {
    singleTab: { presetId: "shell", name: "Claude" },
    tabSessionIds: { left: RC_CONVERSATION },
    claudeTranscriptsIn: "rc-config",
    homeFiles: Object.fromEntries(
      [".zshenv", ".zshrc", ".bash_profile", ".bashrc"].map((rc) => [rc, 'export CLAUDE_CONFIG_DIR="$HOME/rc-config"\n']),
    ),
    presetList: [
      {
        id: "shell",
        name: "Claude",
        icon: "c",
        color: "",
        agent: "claude",
        autoResume: true,
        ...preset,
        command: `${FAKE_CLAUDE} "$AYA_PROJECT_DIR/agent-$AYA_TERMINAL_ID.jsonl"`,
      },
    ],
  },
});

test.describe("a claude pane whose CLAUDE_CONFIG_DIR is set only in the shell's rc file", () => {
  test.use(rcConfigSeed({}));

  test("resumes the conversation Aya cannot see, never a --session-id that claude refuses", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    const launch = launches(projectDir, tabIds.left)[0];
    expect(launch.args).toEqual(["--resume", RC_CONVERSATION]);
    expect(launch.sessionId).toBe(RC_CONVERSATION);
  });
});

test.describe("a claude preset whose configDir label is not the dir the pane runs with", () => {
  test.use(rcConfigSeed({ configDir: "~/.claude" }));

  test("a restored pane resumes the saved conversation, not a --session-id claude refuses", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await waitLaunches(projectDir, tabIds.left, 1);
    expect(launches(projectDir, tabIds.left)[0].args).toEqual(["--resume", RC_CONVERSATION]);
  });
});

const openBin = mkdtempSync(join(tmpdir(), "aya-e2e-opencode-bin-"));
mkdirSync(join(openBin, "b"));
writeFileSync(
  join(openBin, "b", "opencode"),
  [
    "#!/bin/sh",
    'if [ "$1" = session ]; then',
    '  echo asked >> "$PWD/opencode-lookups.log"',
    `  printf '[{"id":"ses_newest","directory":"%s","updated":300}]' "$(pwd -P)"`,
    "  exit 0",
    "fi",
    'echo "ARGS:$*" >> "$AYA_PROJECT_DIR/oc-$AYA_TERMINAL_ID.log"',
    "exec sleep 3600",
    "",
  ].join("\n"),
  { mode: 0o755 },
);
const ocLaunches = (dir: string, tab: string): string[] => {
  const file = join(dir, `oc-${tab}.log`);
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n") : [];
};

const OPENCODE_SEED = {
  launchEnv: { PATH: `${join(openBin, "b")}:${process.env.PATH}`, XDG_DATA_HOME: join(openBin, "xdg") },
  presetList: [{ id: "shell", name: "OpenCode", icon: "o", color: "", agent: "opencode", command: "opencode" }],
};

test.describe("opencode panes that share a folder", () => {
  test.use({
    seedOptions: {
      ...OPENCODE_SEED,
    },
  });

  test("neither resumes the folder's newest session, however they restart", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    const tabs = [tabIds.left, tabIds.right];
    for (const tab of tabs) await expect.poll(() => ocLaunches(projectDir, tab).length, LONG).toBe(1);
    await restart(window, RIGHT);
    await expect.poll(() => ocLaunches(projectDir, tabIds.right).length, LONG).toBe(2);
    await restart(window, LEFT);
    await expect.poll(() => ocLaunches(projectDir, tabIds.left).length, LONG).toBe(2);
    for (const tab of tabs) expect(ocLaunches(projectDir, tab)).toEqual(["ARGS:", "ARGS:"]);
    expect(existsSync(join(projectDir, "opencode-lookups.log"))).toBe(false);
  });
});

test.describe("an opencode pane alone in its folder that shared it once", () => {
  test.use({
    seedOptions: {
      singleTab: { presetId: "shell", name: "OpenCode" },
      leftSharedDir: true,
      ...OPENCODE_SEED,
    },
  });

  test("starts fresh instead of continuing the folder's newest session", async ({ window, seeded }) => {
    void window;
    const { projectDir, tabIds } = seeded;
    await expect.poll(() => ocLaunches(projectDir, tabIds.left).length, LONG).toBe(1);
    expect(ocLaunches(projectDir, tabIds.left)).toEqual(["ARGS:"]);
  });
});

// A remote pane's agent runs on another host: Aya sees neither its transcripts nor its pid.
const remotePreset = (agent: "claude" | "grok") => ({
  id: "remote-agent",
  name: agent,
  icon: "r",
  color: "",
  agent,
  autoResume: true,
  command: agent,
});
const remoteTranscript = (root: string, projectDir: string, id: string) => {
  const dir = join(root, "remote-home", ".claude", "projects", realpathSync(projectDir).replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.jsonl`), "{}\n");
};

const shellPreset = { id: "shell", name: "Shell", icon: "$", color: "", command: "$SHELL" };
/** The launch log of the one agent pane the launcher opened (its tab id is generated). */
const bornLaunches = (projectDir: string) => {
  const file = readdirSync(projectDir).find((f) => /^agent-/.test(f) && f !== "agent-tab-left.jsonl");
  return file ? launches(projectDir, file.slice("agent-".length, -".jsonl".length)) : [];
};

for (const agent of ["claude", "grok"] as const) {
  test.describe(`a remote ${agent} pane opened from the launcher`, () => {
    test.use({
      seedOptions: {
        remoteProject: true,
        singleTab: { presetId: "shell", name: "Shell" },
        presetList: [shellPreset, remotePreset(agent)],
      },
    });

    test("is given no id Aya cannot vouch for, so a restart never resumes a phantom", async ({ window, seeded }) => {
      const { projectDir, ayaHome } = seeded;
      await window.locator(".aya-launcher .aya-launcher-btn", { hasText: agent }).click();
      await expect.poll(() => bornLaunches(projectDir).length, LONG).toBe(1);
      expect(bornLaunches(projectDir)[0].args).toEqual([]);
      await window.waitForTimeout(1500);
      expect(Object.values(savedSessions(ayaHome)).filter(Boolean)).toEqual([]);
      await menu(window, agent, "Restart terminal");
      await expect.poll(() => bornLaunches(projectDir).length, LONG).toBe(2);
      const again = bornLaunches(projectDir)[1].args;
      expect(again).not.toContain("--resume");
      expect(again).not.toContain("--session-id");
    });
  });
}

test.describe("a remote claude pane with a saved id", () => {
  test.use({
    seedOptions: {
      remoteProject: true,
      singleTab: { presetId: "remote-agent", name: "Remote" },
      tabSessionIds: { left: REMOTE_CONVERSATION },
      presetList: [remotePreset("claude")],
    },
  });

  test("keeps resuming it, whatever Aya can see of the remote transcript", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds, root } = seeded;
    const id = REMOTE_CONVERSATION;
    await waitLaunches(projectDir, tabIds.left, 1);
    expect(launches(projectDir, tabIds.left)[0].args).toEqual(["--resume", id]);
    remoteTranscript(root, projectDir, id);
    await restartAndWait(window, projectDir, "Remote", tabIds.left, 2);
    expect(launches(projectDir, tabIds.left)[1]).toMatchObject({ args: ["--resume", id], sessionId: id });
    expect(savedSessions(ayaHome)[tabIds.left]).toBe(id);
  });
});
