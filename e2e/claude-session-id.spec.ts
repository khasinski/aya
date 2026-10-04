// Two claude panes in one folder must each come back to their own
// conversation. Aya never learned a session id, so a restart gave every pane
// `--continue` and they all opened the same, latest conversation.

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_SESSION_POLL_MS } from "../dist-electron/agent-session.js";
import { test, expect } from "./fixtures";
import { SLOW_EXPECT_TIMEOUT_MS } from "./timeouts";
import { agentBin } from "./helpers/agent-bin";

const FAKE_CLAUDE = agentBin("claude", join(__dirname, "helpers", "fake-claude.cjs"));

test.use({
  seedOptions: {
    presetList: [
      {
        id: "shell",
        name: "Claude",
        icon: "c",
        color: "",
        agent: "claude",
        autoResume: true,
        configDir: "~/claude-config",
        command: `CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
      },
    ],
  },
});

/** The transcript Claude saves with a conversation's first message; Aya only
 *  keeps an id it can resume. */
function saveTranscript(root: string, projectDir: string, sessionId: string): void {
  const slug = realpathSync(projectDir).replace(/[^a-zA-Z0-9]/g, "-");
  const dir = join(root, "home", "claude-config", "projects", slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}.jsonl`), "{}\n");
}

type Launch = { args: string[]; sessionId: string; pid: number };

const launches = (projectDir: string, tabId: string): Launch[] => {
  const file = join(projectDir, `claude-${tabId}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Launch);
};

test("each claude pane keeps its own session id and resumes it", async ({ window, seeded }) => {
  const { projectDir, ayaHome, tabIds } = seeded;
  const tabs = [tabIds.left, tabIds.right];
  for (const tab of tabs) {
    await expect.poll(() => launches(projectDir, tab).length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
  }
  const first = Object.fromEntries(tabs.map((tab) => [tab, launches(projectDir, tab)[0].sessionId]));
  expect(first[tabIds.left]).not.toBe(first[tabIds.right]);

  // What the next launch after an update or reboot reads.
  const saved = () => {
    const file = join(ayaHome, "projects", "e2e-proj.json");
    const state = JSON.parse(readFileSync(file, "utf8")) as {
      tabs: { id: string; sessionId?: string }[];
    };
    return Object.fromEntries(state.tabs.map((t) => [t.id, t.sessionId ?? null]));
  };
  await expect.poll(saved, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toMatchObject(first);

  // /clear starts a new conversation and claude rewrites the file with it.
  const cleared = "0b2f3c4d-1111-4222-8333-944455556666";
  const leftPid = launches(projectDir, tabIds.left)[0].pid;
  saveTranscript(seeded.root, projectDir, cleared);
  writeFileSync(
    join(seeded.root, "home", "claude-config", "sessions", `${leftPid}.json`),
    JSON.stringify({ pid: leftPid, sessionId: cleared, cwd: realpathSync(projectDir), startedAt: Date.now() }),
  );
  await expect.poll(saved, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toMatchObject({ [tabIds.left]: cleared });

  const row = window.locator('.aya-sidebar-row[data-terminal-name="shell 2"]');
  await row.click({ button: "right" });
  await window.locator(".aya-context-menu").getByText("Restart terminal").click();
  await expect.poll(() => launches(projectDir, tabIds.right).length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(2);
  const restarted = launches(projectDir, tabIds.right)[1];
  expect(restarted.args).toEqual(["--resume", first[tabIds.right]]);

  // The restarted process is watched too: its next /clear still reaches Aya.
  const afterRestart = "7c8d9e0f-2222-4333-8444-a55566667777";
  saveTranscript(seeded.root, projectDir, afterRestart);
  writeFileSync(
    join(seeded.root, "home", "claude-config", "sessions", `${restarted.pid}.json`),
    JSON.stringify({ pid: restarted.pid, sessionId: afterRestart, cwd: realpathSync(projectDir), startedAt: Date.now() }),
  );
  await expect.poll(saved, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toMatchObject({ [tabIds.right]: afterRestart });
});

test.describe("a preset that sets its config dir only in the command", () => {
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Claude",
          icon: "c",
          color: "",
          agent: "claude",
          autoResume: true,
          // The shell keeps the last CLAUDE_CONFIG_DIR; CODEX_HOME is not claude's.
          command: `CODEX_HOME="$HOME/codex" CLAUDE_CONFIG_DIR="$HOME/stale" CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
        },
      ],
    },
  });

  test("still has each pane's session id saved", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    await expect.poll(() => launches(projectDir, tabIds.left).length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const id = launches(projectDir, tabIds.left)[0].sessionId;
    const saved = () =>
      (JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8")) as {
        tabs: { id: string; sessionId?: string }[];
      }).tabs.find((t) => t.id === tabIds.left)?.sessionId;
    await expect.poll(saved, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(id);
  });
});

test.describe("after an update or reboot", () => {
  const left = "a37e123d-4752-436a-8c1a-595a45fbf5cf";
  const right = "bce5be79-626a-40ca-8944-b26218faa687";
  test.use({
    seedOptions: {
      tabSessionIds: { left, right },
      claudeTranscriptsIn: "claude-config",
      presetList: [
        {
          id: "shell",
          name: "Claude",
          icon: "c",
          color: "",
          agent: "claude",
          autoResume: true,
          configDir: "~/claude-config",
          command: `CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
        },
      ],
    },
  });

  test("each pane starts in the conversation saved for it", async ({ window, seeded }) => {
    const { projectDir, tabIds } = seeded;
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    for (const [tab, id] of [
      [tabIds.left, left],
      [tabIds.right, right],
    ]) {
      await expect.poll(() => launches(projectDir, tab).length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
      expect(launches(projectDir, tab)[0].args).toEqual(["--resume", id]);
    }
  });
});

// A restarted claude may get a dead claude's pid, whose sessions/<pid>.json still names another conversation
// until the new one writes its own; the spawn time pty.ts hands the watcher tells the two files apart.
test.describe("a dead claude's file under the new claude's pid", () => {
  const leftover = "d1e2a3d4-5555-4666-8777-988899990000";
  test.use({
    seedOptions: {
      presetList: [
        {
          id: "shell",
          name: "Claude",
          icon: "c",
          color: "",
          agent: "claude",
          autoResume: true,
          configDir: "~/claude-config",
          // Two of Aya's session polls see only the leftover.
          command: `FAKE_CLAUDE_LEFTOVER=${leftover} FAKE_CLAUDE_LATE_MS=${2 * AGENT_SESSION_POLL_MS + 2_000} CLAUDE_CONFIG_DIR="$HOME/claude-config" ${FAKE_CLAUDE} "$AYA_PROJECT_DIR/claude-$AYA_TERMINAL_ID.jsonl"`,
        },
      ],
    },
  });

  test("is never saved as the pane's conversation; the pane's own is", async ({ window, seeded }) => {
    const { projectDir, ayaHome, tabIds } = seeded;
    await expect(window.getByTestId("xterm-host").first()).toBeVisible();
    await expect.poll(() => launches(projectDir, tabIds.left).length, { timeout: SLOW_EXPECT_TIMEOUT_MS }).toBe(1);
    const { sessionId: own, pid } = launches(projectDir, tabIds.left)[0];
    const sessionFile = join(seeded.root, "home", "claude-config", "sessions", `${pid}.json`);
    const seen = new Set<string | null>();
    // Watched from the spawn until the new claude has written its own file and Aya saved its id after that.
    const ownSavedAfterTrust = () => {
      const late = (JSON.parse(readFileSync(sessionFile, "utf8")) as { sessionId: string }).sessionId === own;
      const id =
        (JSON.parse(readFileSync(join(ayaHome, "projects", "e2e-proj.json"), "utf8")) as {
          tabs: { id: string; sessionId?: string }[];
        }).tabs.find((t) => t.id === tabIds.left)?.sessionId ?? null;
      seen.add(id);
      return late && id === own;
    };
    await expect.poll(ownSavedAfterTrust, { timeout: 45_000, intervals: [100] }).toBe(true);
    expect([...seen]).not.toContain(leftover);
  });
});
