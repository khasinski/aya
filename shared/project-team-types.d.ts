/** Canonical wire types shared by main, preload and renderer. No runtime dependencies. */
import type { SplitNode } from "./split-node.cjs";


/** Agent CLIs Aya knows how to classify and resume. "custom" is anything
 *  else - a plain shell, a script, an agent we have no resume story for. */
export type AgentKind =
  | "claude"
  | "codex"
  | "opencode"
  | "kilo"
  | "pi"
  | "cursor"
  | "copilot"
  | "grok"
  | "droid"
  | "devin"
  | "kimi"
  | "hermes"
  | "qodercli"
  | "antigravity"
  | "custom";

export interface Preset {
  /** How a new pane of this preset opens ("Opens as" in Settings): absent is the terminal. A pane can switch either
   *  way later (WorkingTab.interfaceMode) when its agent has a Conversation GUI. */
  interfaceMode?: "terminal" | "gui";
  id: string;
  name: string;
  icon: string;
  color: string; // hex or "" for default
  command: string;
  agent?: AgentKind;
  configDir?: string;
  unsafeMode?: boolean;
  autoResume?: boolean;
  /** Opt-in: tell the agent that `aya` exists, through its harness's channel
   *  (electron/agent-brief.ts). Harnesses without a channel ignore it. */
  agentBrief?: boolean;
  /** Optional per-preset theme override. Empty/undefined means use the
   *  global active theme. */
  themeId?: string;
}

export interface WorkingTab {
  id: string;
  presetId: string;
  name: string;
  /** Worktree binding: absolute cwd this tab spawns in. Absent = the project's
   *  own directory. Set when the terminal runs in a git worktree. */
  cwd?: string;
  /** Last session id the agent reported over OSC 9001 (see integrations.md).
   *  Lets a restore resume that exact conversation instead of whatever the
   *  CLI considers "latest". Absent for agents that never report one. */
  sessionId?: string;
  /** A same-agent pane has shared this folder once, kept: with no session id
   *  the pane starts fresh, not on the folder's "latest". */
  sharedDir?: true;
  /** Opened for a team role: every launch is widened to reach Aya, unless Aya may not lift the block. */
  teamLaunch?: boolean;
  /** This tab is the host-side record for a detached remote terminal. */
  remoteTerminal?: true;
  /** A tab opened on a machine from the machines popover: it runs `ssh -- <sshTarget>` instead of its preset's command. */
  sshTarget?: string;
  initialBoardCard?: { cardId: string; since: string; previousColumn: string; previousAssignee?: string };
  /** The pane's own mode, set when it was opened or switched; absent follows the preset's `interfaceMode`. */
  interfaceMode?: "terminal" | "gui";
}

export interface SplitLayout {
  rows: number;
  cols: number;
  rowFr: number[];
  colFr: number[];
  cells: (string | null)[];
  activeCell: number;
}

export interface ProjectConfig {
  slug: string;
  name: string;
  directory: string;
  tabs: WorkingTab[];
  /** Legacy flat grid. Read for migration; no longer written. */
  splitLayout?: SplitLayout;
  /** Pane layout as a BSP tree (see src/split-tree.ts). */
  splitTree?: SplitNode;
  remote?: {
    hostId: string;
    label: string;
    sshTarget: string;
    directory: string;
  };
}

export interface RepoProjectConfig {
  presets: Preset[];
}

export interface ProjectCollectionState {
  version: 1;
  order: string[];
  open: string[];
  recent: string[];
  /** Last active project (slug), restored on boot. Optional for back-compat. */
  activeProject?: string | null;
  /** IPC-response-only (never persisted; the save validator strips it): true
   *  when this state was sliced for a secondary window, so the renderer must
   *  NOT apply the first-run "open everything" fallback to the empty list. */
  secondaryWindow?: boolean;
  /** Active terminal id per project slug, so the selection survives a restart. */
  activeTab?: Record<string, string>;
  /** Per-project single-terminal view: the shown terminal id (absent = all/split). */
  singleView?: Record<string, string>;
}

/** One `role=target` of aya team open / the Teams window's Apply: a preset id
 *  (a new session), "this" (the calling pane), or a pane id or name. */
export interface PanePick {
  role: string;
  target: string;
}

/** A preset as aya presets lists it: installed as the pane spawn checks it. */
export interface PresetChoice {
  id: string;
  name: string;
  agent: AgentKind;
  installed: boolean;
  /** Whether a pane Aya opens for a role from this preset reaches Aya. */
  reach: LaunchReach;
  /** Why Aya refuses to open one, when it does. */
  cantReach: string | null;
}

export type LaunchReach = "reaches" | "blocked" | "unknown";

/** A pane main asks the window to open, with the id main picked. */
export interface NewPane {
  id: string;
  presetId: string;
  name: string;
  /** Opened for a team role: launched widened to reach Aya where Aya may (SpawnRequest.teamLaunch). */
  teamLaunch: boolean;
}

export interface TeamOpenPanesRequest {
  requestId: string;
  projectSlug: string;
  panes: NewPane[];
}

export interface PaneChangeRequest {
  requestId: string;
  projectSlug: string;
  paneId: string;
  change: { rename: string } | { close: true };
}

/** The pane a role got: `preset` names a new session's preset, null an existing
 *  pane; `notReached` says why a running team could not introduce it. */
export interface RolePane {
  role: string;
  paneId: string;
  name: string;
  preset: string | null;
  notReached: string | null;
  /** Why the pane's launch mode cannot reach Aya, or why Aya cannot tell (then `unsure`); null when it reaches Aya. */
  cantReach: string | null;
  /** What Aya widened to make it reach Aya, and "may not reach Aya" for an unknown verdict; null when nothing. */
  note: string | null;
  /** Aya cannot tell whether the pane reaches it: no verdict yet, or an unknown one its process has not settled. */
  unsure: boolean;
}

/** Roles given a pane, and roles whose pane moved to another role. */
export interface RolePanes {
  panes: RolePane[];
  leftWithoutPane: string[];
}

/** Which roles got Start team's delivery test, and why the others did not. */
export interface TeamStartResult {
  /** false: a pane was not ready, so nothing was sent; `held` says which. */
  started: boolean;
  /** The team was already running (or another Start is in flight): nothing was sent. */
  alreadyRunning?: boolean;
  /** A role's pane may not resume this pause (team-runner.ts resumeRefusal): nothing was sent. */
  refused?: string;
  delivered: string[];
  held: { role: string; reason: string }[];
  /** The task given with Start: who got it, and why it waits in the inbox, if it does. `messageId`: its log entry. */
  task: { to: string; held: string | null; typedOnly?: boolean; afterEnter?: boolean; messageId?: number } | null;
}

/** A role this one sends to, and what it sends there (may be empty). */
export interface SendRoute {
  to: string;
  what: string;
}

export interface TeamRole {
  id: string;
  sendsTo: SendRoute[];
  mustNot: string;
  responsibilities: string;
}

/** A team from .aya/teams/<name>.md (see electron/team-definition.ts). */
export interface TeamDefinition {
  name: string;
  roles: TeamRole[];
  /** The role that gets the task and the rounds and checks nobody waits too long; null in a team saved before leads. */
  lead: string | null;
  /** The lead gets a round every this many minutes; null: no periodic rounds. The rhythm has no role of its own. */
  cadenceMinutes: number | null;
  /** An old file named another role under "## Lead" than its "## Cadence": that role (the cadence's leads). */
  leadConflict?: string | null;
  protocol: string;
  /** "## Status command": one shell line whose output Aya appends to the lead's round; absent when the team has none. */
  statusCommand?: string;
}

export interface TeamMessage {
  id: number;
  time: string;
  from: string;
  to: string;
  commit: string | null;
  text: string;
  /** Typed into the recipient's pane; the rest wait for its inbox. */
  delivered: boolean;
  /** Why it was not typed when sent, e.g. "shows an approval prompt". */
  held?: string;
  /** Typed into the composer with its Enter withheld: a draft until a human submits it. */
  typedOnly?: boolean;
  /** Typed only, and `held` says what came of the Enter Aya sent (it failed, no turn, a dialog), not why it was withheld. */
  afterEnter?: boolean;
  /** Held, then read by the receiver with `aya team inbox` (set when the log is read with its delivery notes, not stored). */
  viaInbox?: boolean;
}

/** One team as the teams window shows it. `definition` is what Aya runs on:
 *  the saved snapshot, else the repo file; null when that does not parse. */
export interface TeamSummary {
  name: string;
  definition: TeamDefinition | null;
  error: string | null;
  /** The repo file differs from what the user last saved. */
  repoChanged: boolean;
  /** The repo file is gone; Aya runs the saved copy until the user removes the team. */
  repoGone: boolean;
  /** Only the repo file exists (a pull or a clone brought it): nothing of it
   *  runs until the user saves it in Aya. */
  unsaved: boolean;
  /** The repo file parsed, to adopt with one Save; null when it does not parse. */
  repoDefinition: TeamDefinition | null;
  paused: boolean;
  /** Started with Start team and not paused since. */
  running: boolean;
  /** Saved by an agent from a pane: the agent proposes its panes, no prompt needed. */
  agentAuthored: boolean;
  assignments: Record<string, string>;
  /** Per role with a pane in the project: why a message would wait now, null when it would not. */
  paneHolds: Record<string, string | null>;
  /** Per role with a pane: a note explaining what Aya can do, plus whether the user needs to act. */
  roleNotes: Record<string, { text: string; severity: "info" | "action" } | null>;
  /** Roles whose note a restart of their pane (it resumes) gives; not a CLI that cannot take one, nor Codex. */
  restartable: string[];
  /** Panes that started with a role note of this team that they no longer play. */
  staleNotes: string[];
  /** Per role with a pane: when a Save changed what its aya team whoami prints, while it has not run whoami since. */
  olderRoles: Record<string, string>;
  /** Per role with a pane in the project: what Aya widened so the pane reaches it, null when nothing. */
  paneNotes: Record<string, string | null>;
  /** Messages per role that are waiting in its inbox. */
  unread: Record<string, number>;
  /** Per role, the roles its reply says it sent to while nothing from it reached them (electron/unsent-claims.ts). */
  unsent?: Record<string, string[]>;
  liveness: TeamLiveness;
  log: TeamMessage[];
}

/** Whether the team's rounds get any answer. */
export interface TeamLiveness {
  status: "never started" | "paused" | "progressing" | "talking" | "stalled" | "blocked" | "unreachable";
  /** Set while stalled: the last change to the repo (ISO). */
  stalledSince: string | null;
  blocked: { role: string; reason: string; since: string }[];
  /** The role rounds go to, while its pane has taken none for several rounds (not running, a draft, a shell). */
  unreached: { role: string; reason: string; since: string } | null;
  /** What watches a team: the lead gets a round every `everyMin` (null: no cadence) and is asked for one after
   *  `askAfterMin` of quiet (null: the team has no lead); the team is stalled after `stalledAfterMin`. */
  silence: { askAfterMin: number | null; everyMin?: number | null; stalledAfterMin: number };
  /** While running: the last change to the repo (ISO) and the peer messages since it. */
  repo?: { since: string; messages: number } | null;
  /** The lead did not answer its last `rounds` rounds: the next ones wait for its answer. */
  roundsHeld?: { role: string; rounds: number } | null;
}

/** A role drafted by Aya Intelligence from its name, for the user to edit. */
export interface RoleDraft {
  responsibilities: string;
  mustNot: string;
  sendsTo: SendRoute[];
}
