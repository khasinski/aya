// Example scenarios for the Aya emulator. Add your own and select with
// ?scenario=<name>. Each is a complete, screenshottable UI state.

import type { UsageAccount } from "../types";
import type { EmScenario } from "./scenario";

const now = () => new Date().toISOString();

const claudeAccounts: UsageAccount[] = [
  {
    id: "work",
    label: "you@work",
    usage: {
      fiveHour: { pct: 34 },
      sevenDay: { pct: 61, resetsAt: "2026-09-01T00:00:00Z" },
      updatedAt: now(),
    },
  },
];

const codexAccounts: UsageAccount[] = [
  {
    id: "personal",
    label: "you@personal",
    usage: { sevenDay: { pct: 18 }, updatedAt: now() },
  },
];

// A believable Claude Code pane mid-task.
const CLAUDE_OUTPUT = [
  "\x1b[38;2;215;119;87m✻\x1b[0m Welcome to \x1b[1mClaude Code\x1b[0m",
  "",
  "\x1b[2m> refactor the auth middleware to use the new token service\x1b[0m",
  "",
  "\x1b[32m●\x1b[0m I'll update \x1b[36msrc/auth/middleware.ts\x1b[0m to delegate to",
  "  \x1b[36mTokenService\x1b[0m and drop the inline JWT parsing.",
  "",
  "\x1b[32m✔\x1b[0m Edited \x1b[36msrc/auth/middleware.ts\x1b[0m \x1b[2m(+18 -24)\x1b[0m",
  "\x1b[32m✔\x1b[0m Edited \x1b[36msrc/auth/token-service.ts\x1b[0m \x1b[2m(+7 -1)\x1b[0m",
  "",
  "\x1b[33m▲\x1b[0m Run the auth test suite to confirm?",
  "",
].join("\r\n");

const SHELL_OUTPUT = [
  "\x1b[2m$\x1b[0m npm test -- auth",
  "",
  "\x1b[32m PASS \x1b[0m tests/auth/middleware.test.ts",
  "\x1b[32m PASS \x1b[0m tests/auth/token-service.test.ts",
  "",
  "Test Suites: \x1b[32m2 passed\x1b[0m, 2 total",
  "Tests:       \x1b[32m24 passed\x1b[0m, 24 total",
  "",
  "\x1b[2m$\x1b[0m ",
].join("\r\n");

const CODEX_OUTPUT = [
  "\x1b[38;2;16;163;127m◆\x1b[0m \x1b[1mCodex\x1b[0m",
  "",
  "\x1b[2m> add a rate limiter to the public API\x1b[0m",
  "",
  "\x1b[32m●\x1b[0m Working on \x1b[36msrc/web/rate-limit.ts\x1b[0m…",
  "",
].join("\r\n");

/** The default, well-populated state: two projects, the active one split into
 *  a Claude pane (waiting on approval) and a shell pane, usage chips, and a
 *  dirty git branch. */
const defaultScenario: EmScenario = {
  name: "default",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/token-service", dirty: 5 },
      activeTabId: "aya-claude",
      tabs: [
        {
          id: "aya-claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_OUTPUT,
          status: "waiting",
          statusText: "Run the auth test suite?",
        },
        {
          id: "aya-shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      tabs: [
        {
          id: "web-codex",
          presetId: "codex",
          name: "Codex",
          content: CODEX_OUTPUT,
          status: "active",
        },
      ],
    },
  ],
};

/** A busier state: a 3-pane project with a waiting agent, a failed one, and a
 *  running one, so the status rail shows "1 waiting / 1 failed". */
const busyScenario: EmScenario = {
  name: "busy",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/token-service", dirty: 5 },
      activeTabId: "aya-claude",
      tabs: [
        {
          id: "aya-claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_OUTPUT,
          status: "waiting",
          statusText: "Approve edit to middleware.ts?",
        },
        {
          id: "aya-codex",
          presetId: "codex",
          name: "Codex",
          content:
            "\x1b[38;2;16;163;127m◆\x1b[0m Codex\r\n\r\n\x1b[31m✖ command failed: eslint (exit 1)\x1b[0m\r\n",
          status: "error",
          statusText: "eslint failed",
        },
        {
          id: "aya-shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 2 },
      tabs: [
        {
          id: "web-grok",
          presetId: "grok",
          name: "Grok",
          content: "\x1b[1m𝕏 Grok\x1b[0m\r\n\r\nReady.\r\n",
        },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// Feature-showcase scenarios
// ---------------------------------------------------------------------------

const CLAUDE_FOCUS = [
  "\x1b[38;2;215;119;87m✻\x1b[0m \x1b[1mClaude Code\x1b[0m",
  "",
  "\x1b[2m> add retry with exponential backoff to the upload client\x1b[0m",
  "",
  "\x1b[32m●\x1b[0m I'll add a jittered backoff helper and wrap \x1b[36muploadChunk\x1b[0m in a",
  "  retry loop that honors \x1b[36mRetry-After\x1b[0m and caps at 5 attempts.",
  "",
  "  \x1b[32m✔\x1b[0m Edited \x1b[36msrc/upload/client.ts\x1b[0m \x1b[2m(+34 -6)\x1b[0m",
  "  \x1b[32m✔\x1b[0m Created \x1b[36msrc/upload/backoff.ts\x1b[0m \x1b[2m(+28)\x1b[0m",
  "",
  "\x1b[2m⏺ npm test -- upload\x1b[0m",
  "  \x1b[42m\x1b[30m PASS \x1b[0m tests/upload/backoff.test.ts",
  "  \x1b[42m\x1b[30m PASS \x1b[0m tests/upload/client.test.ts",
  "  Tests: \x1b[32m12 passed\x1b[0m, 12 total",
  "",
  "\x1b[32m●\x1b[0m Done — transient 5xx retries with jitter, \x1b[36mRetry-After\x1b[0m honored,",
  "  and the final error surfaces after the cap.",
  "",
  "\x1b[2m>\x1b[0m \x1b[7m \x1b[0m",
  "",
].join("\r\n");

const GEMINI_OUTPUT = [
  "\x1b[38;2;66;133;244mG\x1b[0m \x1b[1mGemini\x1b[0m",
  "",
  "\x1b[2m> summarize the open PRs\x1b[0m",
  "",
  "\x1b[32m●\x1b[0m 3 open PRs:",
  "  \x1b[36m#142\x1b[0m upload retry/backoff \x1b[2m(ready)\x1b[0m",
  "  \x1b[36m#141\x1b[0m rate limiter \x1b[33m(changes requested)\x1b[0m",
  "  \x1b[36m#138\x1b[0m docs: emulator \x1b[2m(draft)\x1b[0m",
  "",
].join("\r\n");

const GIT_SHELL = [
  "\x1b[2m$\x1b[0m git status -sb",
  "\x1b[36m## feat/token-service\x1b[0m",
  "\x1b[32mM\x1b[0m  src/auth/middleware.ts",
  "\x1b[32mM\x1b[0m  src/auth/token-service.ts",
  "\x1b[31m??\x1b[0m src/auth/backoff.ts",
  "",
  "\x1b[2m$\x1b[0m ",
].join("\r\n");

const REVIEWER_OUTPUT = [
  "\x1b[38;2;16;163;127m◆\x1b[0m \x1b[1mreviewer\x1b[0m \x1b[2m(Codex)\x1b[0m",
  "",
  "\x1b[2m# received from coder via `aya pane send`:\x1b[0m",
  "\x1b[2m> review the diff on feat/token-service\x1b[0m",
  "",
  "\x1b[32m●\x1b[0m Looks solid. Two notes:",
  "  \x1b[33m▲\x1b[0m \x1b[36mmiddleware.ts:42\x1b[0m — token lookup should be cached per request",
  "  \x1b[33m▲\x1b[0m missing a test for the expired-token path",
  "",
  "\x1b[32m✔\x1b[0m Otherwise LGTM.",
  "",
].join("\r\n");

const CODER_OUTPUT = [
  "\x1b[38;2;215;119;87m✻\x1b[0m \x1b[1mcoder\x1b[0m \x1b[2m(Claude)\x1b[0m",
  "",
  "\x1b[32m✔\x1b[0m Edited \x1b[36msrc/auth/middleware.ts\x1b[0m \x1b[2m(+18 -24)\x1b[0m",
  "",
  "\x1b[2m$ aya pane send \"reviewer\" \"review the diff on feat/token-service\" --submit\x1b[0m",
  "\x1b[32m●\x1b[0m Handed the diff to \x1b[1mreviewer\x1b[0m. Waiting for notes…",
  "",
].join("\r\n");

/** Tiling splits: one project, four agents in a 2x2 BSP grid. */
const tilingScenario: EmScenario = {
  name: "tiling",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/token-service", dirty: 3 },
      activeTabId: "claude",
      tabs: [
        { id: "claude", presetId: "claude", name: "Claude", content: CLAUDE_OUTPUT },
        { id: "codex", presetId: "codex", name: "Codex", content: CODEX_OUTPUT, status: "active" },
        { id: "gemini", presetId: "gemini", name: "Gemini", content: GEMINI_OUTPUT },
        { id: "shell", presetId: "shell", name: "Shell", content: GIT_SHELL },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
    },
  ],
};

/** Attention across projects: the status rail lists waiting + failed panes,
 *  including one in a project you aren't looking at. */
const attentionScenario: EmScenario = {
  name: "attention",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/token-service", dirty: 5 },
      activeTabId: "claude",
      tabs: [
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_OUTPUT,
          status: "waiting",
          statusText: "Run the auth test suite?",
        },
        { id: "shell", presetId: "shell", name: "Shell", content: SHELL_OUTPUT },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 2 },
      activeTabId: "web-codex",
      tabs: [
        {
          id: "web-codex",
          presetId: "codex",
          name: "Codex",
          content:
            "\x1b[38;2;16;163;127m◆\x1b[0m Codex\r\n\r\n\x1b[31m✖ build failed: type error in rate-limit.ts\x1b[0m\r\n",
          status: "error",
          statusText: "build failed",
        },
        {
          id: "web-cursor",
          presetId: "cursor",
          name: "Cursor",
          content: "\x1b[1m▲ Cursor Agent\x1b[0m\r\n\r\n\x1b[33m▲ Apply 3 edits to api/routes.ts?\x1b[0m\r\n",
          status: "waiting",
          statusText: "Apply 3 edits?",
        },
      ],
    },
  ],
};

/** Agents driving each other: a coder pane hands the diff to a reviewer pane. */
const orchestrationScenario: EmScenario = {
  name: "orchestration",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/token-service", dirty: 4 },
      activeTabId: "coder",
      tabs: [
        { id: "coder", presetId: "claude", name: "coder", content: CODER_OUTPUT },
        {
          id: "reviewer",
          presetId: "codex",
          name: "reviewer",
          content: REVIEWER_OUTPUT,
          status: "waiting",
          statusText: "2 notes on the diff",
        },
      ],
    },
  ],
};

/** A single, calm agent session — the focused single-pane view. */
const focusScenario: EmScenario = {
  name: "focus",
  platform: "darwin",
  homeDir: "/Users/you",
  usage: claudeAccounts,
  codexUsage: codexAccounts,
  activeProjectSlug: "aya",
  projects: [
    {
      slug: "aya",
      name: "aya",
      directory: "/Users/you/Projects/aya",
      git: { branch: "feat/upload-retry", dirty: 3 },
      activeTabId: "claude",
      tabs: [
        { id: "claude", presetId: "claude", name: "Claude", content: CLAUDE_FOCUS },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
    },
  ],
};

export const SCENARIOS: Record<string, EmScenario> = {
  default: defaultScenario,
  busy: busyScenario,
  tiling: tilingScenario,
  attention: attentionScenario,
  orchestration: orchestrationScenario,
  focus: focusScenario,
};

export function pickScenario(name: string | null): EmScenario {
  return (name && SCENARIOS[name]) || SCENARIOS.default;
}
