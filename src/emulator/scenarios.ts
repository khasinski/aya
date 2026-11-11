// Example scenarios for the Aya emulator. Add your own and select with
// ?scenario=<name>. Each is a complete, screenshottable UI state.
//
// The emulator renders in dark mode by default (override with ?theme=light).
// Tab/project `summary` fields simulate Apple Intelligence labels: they seed
// the local-summary cache so the sidebar shows a one-line label under each tab
// and the top-bar tab shows the project label in place of its path.

import type { BoardSnapshot, TeamSummary, UsageAccount } from "../types";
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

// Authentic Claude Code session waiting on a command approval prompt.
const CLAUDE_WAITING_OUTPUT = [
  " \x1b[38;2;215;119;87m▐\x1b[48;2;0;0;0m▛███▛█\x1b[39m\x1b[49m   \x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.287\x1b[0m",
  "\x1b[38;2;215;119;87m▝▜\x1b[48;2;0;0;0m█████\x1b[49m█▀\x1b[0m  \x1b[38;2;153;153;153mOpus 5.5 · Claude Max\x1b[0m",
  " \x1b[38;2;215;119;87m▝▝   ▝▝\x1b[0m   \x1b[38;2;153;153;153m~/Projects/aya\x1b[0m",
  "",
  "\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;252mrefactor the auth middleware to use TokenService and run the auth tests   \x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m I'll update \x1b[36msrc/auth/middleware.ts\x1b[0m to delegate token verification to",
  "  \x1b[36mTokenService\x1b[0m and remove the inline JWT parsing.",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/auth/middleware.ts)",
  "  \x1b[2m⎿  Updated src/auth/middleware.ts with 18 additions and 24 removals\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/auth/token-service.ts)",
  "  \x1b[2m⎿  Updated src/auth/token-service.ts with 7 additions and 1 removal\x1b[0m",
  "",
  "\x1b[33m⏺\x1b[0m \x1b[1mBash\x1b[22m(npm test -- tests/auth)",
  "",
  "  This command requires approval",
  "",
  "  Do you want to proceed?",
  "  \x1b[38;5;153m❯\x1b[39m \x1b[38;5;246m1. \x1b[38;5;153mYes\x1b[0m",
  "    \x1b[38;5;246m2. \x1b[0mYes, and don't ask again for: \x1b[1mnpm test:*\x1b[0m",
  "    \x1b[38;5;246m3. \x1b[0mNo",
  "",
  "  \x1b[38;5;246mEsc to cancel · Tab to amend\x1b[0m",
].join("\r\n");

// Authentic Claude Code session that completed a task and sits at the composer.
const CLAUDE_DEFAULT_OUTPUT = [
  " \x1b[38;2;215;119;87m▐\x1b[48;2;0;0;0m▛███▛█\x1b[39m\x1b[49m   \x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.287\x1b[0m",
  "\x1b[38;2;215;119;87m▝▜\x1b[48;2;0;0;0m█████\x1b[49m█▀\x1b[0m  \x1b[38;2;153;153;153mOpus 5.5 · Claude Max\x1b[0m",
  " \x1b[38;2;215;119;87m▝▝   ▝▝\x1b[0m   \x1b[38;2;153;153;153m~/Projects/aya\x1b[0m",
  "",
  "\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;252mextract the token verification into TokenService and update middleware.ts \x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/auth/token-service.ts)",
  "  \x1b[2m⎿  Updated src/auth/token-service.ts with 26 additions and 4 removals\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/auth/middleware.ts)",
  "  \x1b[2m⎿  Updated src/auth/middleware.ts with 18 additions and 24 removals\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[22m(npm test -- tests/auth)",
  "  \x1b[2m⎿  PASS  tests/auth/middleware.test.ts (14 tests)\x1b[0m",
  "  \x1b[2m   PASS  tests/auth/token-service.test.ts (10 tests)\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m Middleware now delegates verification to \x1b[36mTokenService\x1b[0m and all 24 auth",
  "  tests pass.",
  "",
  "\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "❯ \x1b[7m \x1b[0m",
  "\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "  \x1b[38;2;153;153;153m⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\x1b[0m",
].join("\r\n");

const SHELL_OUTPUT = [
  "\x1b[2m$\x1b[0m npm test -- tests/auth",
  "",
  " \x1b[32m✓\x1b[0m tests/auth/middleware.test.ts \x1b[2m(14 tests) 42ms\x1b[0m",
  " \x1b[32m✓\x1b[0m tests/auth/token-service.test.ts \x1b[2m(10 tests) 31ms\x1b[0m",
  "",
  " Test Files  \x1b[1m\x1b[32m2 passed\x1b[0m \x1b[2m(2)\x1b[0m",
  "      Tests  \x1b[1m\x1b[32m24 passed\x1b[0m \x1b[2m(24)\x1b[0m",
  "",
  "\x1b[2m$\x1b[0m git status -sb",
  "\x1b[36m## feat/token-service\x1b[0m",
  " \x1b[32mM\x1b[0m src/auth/middleware.ts",
  " \x1b[32mM\x1b[0m src/auth/token-service.ts",
  "",
  "\x1b[2m$\x1b[0m ",
].join("\r\n");

const CODEX_OUTPUT = [
  "  \x1b[38;2;99;168;248m>_\x1b[0m \x1b[1mOpenAI Codex\x1b[22m \x1b[2m(v0.160.0)\x1b[0m",
  "     \x1b[2m~/Projects/aya\x1b[0m",
  "",
  "\x1b[1m›\x1b[22m add sliding-window rate limiting to src/web/rate-limit.ts",
  "",
  "• Edited \x1b[36msrc/web/rate-limit.ts\x1b[0m \x1b[2m(+41 -8)\x1b[0m",
  "• Running \x1b[2mnpm test -- tests/web/rate-limit.test.ts\x1b[0m",
  "",
  "• Working \x1b[2m(4s • esc to interrupt)\x1b[0m",
  "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m",
].join("\r\n");

const CLAUDE_FOCUS = [
  " \x1b[38;2;215;119;87m▐\x1b[48;2;0;0;0m▛███▛█\x1b[39m\x1b[49m   \x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.287\x1b[0m",
  "\x1b[38;2;215;119;87m▝▜\x1b[48;2;0;0;0m█████\x1b[49m█▀\x1b[0m  \x1b[38;2;153;153;153mOpus 5.5 · Claude Max\x1b[0m",
  " \x1b[38;2;215;119;87m▝▝   ▝▝\x1b[0m   \x1b[38;2;153;153;153m~/Projects/aya\x1b[0m",
  "",
  "\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;252madd retry with exponential backoff to the upload client                   \x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m I'll add a jittered backoff helper and wrap \x1b[36muploadChunk\x1b[0m in a retry",
  "  loop that honors \x1b[36mRetry-After\x1b[0m and caps at 5 attempts.",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mWrite\x1b[22m(src/upload/backoff.ts)",
  "  \x1b[2m⎿  Wrote 28 lines to src/upload/backoff.ts\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/upload/client.ts)",
  "  \x1b[2m⎿  Updated src/upload/client.ts with 34 additions and 6 removals\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[22m(npm test -- tests/upload)",
  "  \x1b[2m⎿  PASS  tests/upload/backoff.test.ts (6 tests)\x1b[0m",
  "  \x1b[2m   PASS  tests/upload/client.test.ts (6 tests)\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m Done — transient 5xx responses retry with jitter, \x1b[36mRetry-After\x1b[0m headers",
  "  are respected, and the final error surfaces after 5 attempts.",
  "",
  "\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "❯ \x1b[7m \x1b[0m",
  "\x1b[38;2;136;136;136m──────────────────────────────────────────────────────────────────────────────\x1b[0m",
  "  \x1b[38;2;153;153;153m⏵⏵ auto mode on (shift+tab to cycle) · ← for agents\x1b[0m",
].join("\r\n");

const REVIEWER_OUTPUT = [
  "  \x1b[38;2;99;168;248m>_\x1b[0m \x1b[1mOpenAI Codex\x1b[22m \x1b[2m(v0.160.0)\x1b[0m",
  "     \x1b[2m~/Projects/aya\x1b[0m",
  "",
  "\x1b[1m›\x1b[22m [team auth-review | from coder | 14:22 | 3f8a19c] TokenService refactor",
  "  is ready on feat/token-service. Please review src/auth/middleware.ts.",
  "",
  "• Ran \x1b[2mgit diff main...feat/token-service -- src/auth/\x1b[0m",
  "• Reviewed \x1b[36msrc/auth/middleware.ts\x1b[0m and \x1b[36msrc/auth/token-service.ts\x1b[0m",
  "• Ran \x1b[2maya team send coder \"Reviewed 3f8a19c: cache token lookup per request in middleware.ts:42 and add an expired-token test.\"\x1b[0m",
  "",
  "• Sent review notes to \x1b[1mcoder\x1b[22m.",
  "",
  "\x1b[1m›\x1b[22m \x1b[2mAsk Codex to do anything\x1b[0m",
].join("\r\n");

const CODER_OUTPUT = [
  " \x1b[38;2;215;119;87m▐\x1b[48;2;0;0;0m▛███▛█\x1b[39m\x1b[49m   \x1b[1mClaude Code\x1b[22m \x1b[38;2;153;153;153mv2.1.287\x1b[0m",
  "\x1b[38;2;215;119;87m▝▜\x1b[48;2;0;0;0m█████\x1b[49m█▀\x1b[0m  \x1b[38;2;153;153;153mOpus 5.5 · Claude Max\x1b[0m",
  " \x1b[38;2;215;119;87m▝▝   ▝▝\x1b[0m   \x1b[38;2;153;153;153m~/Projects/aya\x1b[0m",
  "",
  "\x1b[48;5;237m\x1b[38;5;239m❯ \x1b[38;5;252m[team auth-review | from reviewer | 14:24 | 3f8a19c] Reviewed 3f8a19c:    \x1b[0m",
  "\x1b[48;5;237m\x1b[38;5;252m  cache token lookup per request in middleware.ts:42 and add an expired-    \x1b[0m",
  "\x1b[48;5;237m\x1b[38;5;252m  token test.                                                               \x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(src/auth/middleware.ts)",
  "  \x1b[2m⎿  Cached verified token on req.authContext\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mUpdate\x1b[22m(tests/auth/token-service.test.ts)",
  "  \x1b[2m⎿  Added expired-token rejection test\x1b[0m",
  "",
  "\x1b[32m⏺\x1b[0m \x1b[1mBash\x1b[22m(aya team send reviewer \"Addressed both notes in 9c4d210; all 25 auth tests pass.\")",
  "  \x1b[2m⎿  Delivered to reviewer\x1b[0m",
].join("\r\n");

const authReviewTeam: TeamSummary = {
  name: "auth-review",
  definition: {
    name: "auth-review",
    lead: "coder",
    cadenceMinutes: 5,
    protocol: "Coder implements and commits; reviewer inspects diffs and tests.",
    roles: [
      {
        id: "coder",
        sendsTo: [{ to: "reviewer", what: "Completed diff for review" }],
        mustNot: "",
        responsibilities: "Implement auth changes and run tests",
      },
      {
        id: "reviewer",
        sendsTo: [{ to: "coder", what: "Review notes or approval" }],
        mustNot: "",
        responsibilities: "Review diffs on feat/token-service",
      },
    ],
  },
  error: null,
  repoChanged: false,
  repoGone: false,
  unsaved: false,
  repoDefinition: null,
  paused: false,
  running: true,
  agentAuthored: false,
  assignments: {
    coder: "coder",
    reviewer: "reviewer",
  },
  paneHolds: {
    coder: null,
    reviewer: null,
  },
  roleNotes: {
    coder: null,
    reviewer: null,
  },
  restartable: [],
  staleNotes: [],
  olderRoles: {},
  paneNotes: {},
  unread: {
    coder: 0,
    reviewer: 0,
  },
  liveness: {
    status: "progressing",
    stalledSince: null,
    blocked: [],
    unreached: null,
    silence: { askAfterMin: 5, everyMin: 5, stalledAfterMin: 15 },
  },
  log: [],
};

/** The default, well-populated state: two projects, multiple tabs in the
 *  sidebar with Apple Intelligence labels, usage rings in the top bar, and a
 *  single active terminal pane in the main view. */
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
      git: { branch: "feat/token-service", dirty: 2 },
      summary: "Auth token-service refactor",
      activeTabId: "aya-claude",
      singleViewTabId: "aya-claude",
      tabs: [
        {
          id: "aya-claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_DEFAULT_OUTPUT,
          summary: "Refactoring the auth middleware",
        },
        {
          id: "aya-codex",
          presetId: "codex",
          name: "Codex",
          content: CODEX_OUTPUT,
          status: "active",
          summary: "Adding an API rate limiter",
        },
        {
          id: "aya-shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      summary: "Public API rate limiting",
      activeTabId: "web-codex",
      singleViewTabId: "web-codex",
      tabs: [
        {
          id: "web-codex",
          presetId: "codex",
          name: "Codex",
          content: CODEX_OUTPUT,
          status: "active",
          summary: "Adding an API rate limiter",
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
      summary: "Auth token-service refactor",
      activeTabId: "aya-claude",
      singleViewTabId: "aya-claude",
      tabs: [
        {
          id: "aya-claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_WAITING_OUTPUT,
          status: "waiting",
          statusText: "waiting for input",
          summary: "Refactoring the auth middleware",
        },
        {
          id: "aya-codex",
          presetId: "codex",
          name: "Codex",
          content:
            "  \x1b[38;2;99;168;248m>_\x1b[0m \x1b[1mOpenAI Codex\x1b[22m \x1b[2m(v0.160.0)\x1b[0m\r\n\r\n\x1b[31m✖ command failed: eslint (exit 1)\x1b[0m\r\n",
          status: "error",
          statusText: "eslint failed",
          summary: "eslint failing on the token module",
        },
        {
          id: "aya-shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
  ],
};

/** Tiling splits: two terminals side by side in one project (the ONLY
 *  side-by-side split screenshot on aya.codes). */
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
      git: { branch: "feat/token-service", dirty: 2 },
      summary: "Auth token-service refactor",
      activeTabId: "claude",
      tabs: [
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_DEFAULT_OUTPUT,
          summary: "Refactoring the auth middleware",
        },
        {
          id: "shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      summary: "Public API rate limiting",
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
    },
  ],
};

/** Attention across projects: the status rail lists waiting + failed panes,
 *  including one in a project you aren't looking at, while the main view shows
 *  a single terminal waiting on an approval prompt. */
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
      git: { branch: "feat/token-service", dirty: 2 },
      summary: "Auth token-service refactor",
      activeTabId: "claude",
      singleViewTabId: "claude",
      tabs: [
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_WAITING_OUTPUT,
          status: "waiting",
          statusText: "waiting for input",
          summary: "Refactoring the auth middleware",
        },
        {
          id: "shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 2 },
      summary: "Public API rate limiting",
      activeTabId: "web-codex",
      singleViewTabId: "web-codex",
      tabs: [
        {
          id: "web-codex",
          presetId: "codex",
          name: "Codex",
          content:
            "  \x1b[38;2;99;168;248m>_\x1b[0m \x1b[1mOpenAI Codex\x1b[22m \x1b[2m(v0.160.0)\x1b[0m\r\n\r\n\x1b[31m✖ build failed: type error in rate-limit.ts\x1b[0m\r\n",
          status: "error",
          statusText: "build failed",
          summary: "Type error in rate-limit.ts",
        },
      ],
    },
  ],
};

/** Agents working as a team: single-pane view of the coder pane with real
 *  team role chips (`auth-review · coder`, `auth-review · reviewer`) in the
 *  sidebar and `aya team send` message delivery. */
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
      git: { branch: "feat/token-service", dirty: 2 },
      summary: "Auth middleware review loop",
      activeTabId: "coder",
      singleViewTabId: "coder",
      teams: [authReviewTeam],
      tabs: [
        {
          id: "coder",
          presetId: "claude",
          name: "coder",
          content: CODER_OUTPUT,
          summary: "Addressed review notes on middleware.ts",
        },
        {
          id: "reviewer",
          presetId: "codex",
          name: "reviewer",
          content: REVIEWER_OUTPUT,
          summary: "Reviewing feat/token-service diff",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      summary: "Public API rate limiting",
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
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
      git: { branch: "feat/upload-retry", dirty: 2 },
      summary: "Upload retry & backoff",
      activeTabId: "claude",
      singleViewTabId: "claude",
      tabs: [
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_FOCUS,
          summary: "Adding upload retry with backoff",
        },
        {
          id: "shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      summary: "Public API rate limiting",
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
    },
  ],
};

const SAMPLE_KANBAN_BOARD: BoardSnapshot = {
  version: 1,
  projectSlug: "aya",
  source: "user",
  filePath: "~/.aya/boards/aya.json",
  columns: [
    { id: "todo", title: "Todo" },
    { id: "in-progress", title: "In Progress" },
    { id: "review", title: "Review" },
    { id: "done", title: "Done" },
  ],
  cards: [
    {
      id: "t-1",
      columnId: "done",
      title: "Store board in ~/.aya/boards with .aya/board.json priority",
      description: "Fallback to user config when no repo board file exists.",
      assignee: "Claude",
      createdAt: "2026-11-11T17:00:00.000Z",
      updatedAt: "2026-11-11T17:30:00.000Z",
    },
    {
      id: "t-2",
      columnId: "in-progress",
      title: "Add aya board CLI (list, add, move, claim, release)",
      description: "Allow terminals to claim and release tasks directly from the shell.",
      assignee: "Claude",
      claim: {
        paneId: "claude",
        paneName: "Claude",
        since: "2026-11-11T18:10:00.000Z",
      },
      createdAt: "2026-11-11T17:15:00.000Z",
      updatedAt: "2026-11-11T18:10:00.000Z",
    },
    {
      id: "t-3",
      columnId: "in-progress",
      title: "Rate-limit public API endpoints",
      description: "Sliding-window limiter in src/web/rate-limit.ts.",
      assignee: "Codex",
      claim: {
        paneId: "codex",
        paneName: "Codex",
        since: "2026-11-11T18:22:00.000Z",
      },
      createdAt: "2026-11-11T17:20:00.000Z",
      updatedAt: "2026-11-11T18:22:00.000Z",
    },
    {
      id: "t-4",
      columnId: "review",
      title: "Extract token verification into TokenService",
      description: "All 24 auth tests passing on feat/token-service.",
      assignee: "Claude",
      createdAt: "2026-11-11T17:05:00.000Z",
      updatedAt: "2026-11-11T18:05:00.000Z",
    },
    {
      id: "t-5",
      columnId: "todo",
      title: "Add e2e test for repo board promotion",
      description: "Verify Save to .aya/board.json switches badge to repo.",
      createdAt: "2026-11-11T18:30:00.000Z",
      updatedAt: "2026-11-11T18:30:00.000Z",
    },
    {
      id: "t-6",
      columnId: "todo",
      title: "Support keyboard shortcuts for moving cards",
      createdAt: "2026-11-11T18:35:00.000Z",
      updatedAt: "2026-11-11T18:35:00.000Z",
    },
  ],
};

const kanbanScenario: EmScenario = {
  name: "kanban",
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
      git: { branch: "feat/kanban-board", dirty: 2 },
      summary: "Built-in per-project Kanban board",
      board: SAMPLE_KANBAN_BOARD,
      activeTabId: "board",
      singleViewTabId: "board",
      tabs: [
        {
          id: "board",
          presetId: "board",
          name: "Kanban",
        },
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: CLAUDE_DEFAULT_OUTPUT,
          summary: "Working on t-2 (aya board CLI)",
        },
        {
          id: "codex",
          presetId: "codex",
          name: "Codex",
          content: CODEX_OUTPUT,
          summary: "Claimed t-3 · sliding-window limiter",
          status: "active",
          statusText: "Running rate-limit tests",
        },
        {
          id: "shell",
          presetId: "shell",
          name: "Shell",
          content: SHELL_OUTPUT,
          summary: "Auth test suite — 24 passed",
        },
      ],
    },
    {
      slug: "webapp",
      name: "webapp",
      directory: "/Users/you/Projects/webapp",
      git: { branch: "main", dirty: 0 },
      summary: "Public API rate limiting",
      tabs: [{ id: "web-shell", presetId: "shell", name: "Shell", content: "\x1b[2m$\x1b[0m " }],
    },
  ],
};

const kanbanSplitScenario: EmScenario = {
  name: "kanban-split",
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
      git: { branch: "feat/kanban-board", dirty: 2 },
      summary: "Built-in per-project Kanban board",
      board: {
        ...SAMPLE_KANBAN_BOARD,
        source: "repo",
        filePath: "/Users/you/Projects/aya/.aya/board.json",
      },
      activeTabId: "board",
      tabs: [
        {
          id: "board",
          presetId: "board",
          name: "Kanban",
        },
        {
          id: "claude",
          presetId: "claude",
          name: "Claude",
          content: [
            CLAUDE_DEFAULT_OUTPUT,
            "",
            "\x1b[2m$\x1b[0m aya board claim t-2",
            "claimed t-2 (in-progress) for Claude: Add aya board CLI (list, add, move, claim, release)",
          ].join("\r\n"),
          summary: "Claimed t-2 · aya board CLI",
        },
      ],
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
  kanban: kanbanScenario,
  "kanban-split": kanbanSplitScenario,
};

export function pickScenario(name: string | null): EmScenario {
  return (name && SCENARIOS[name]) || SCENARIOS.default;
}
