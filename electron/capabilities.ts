// Agents learn the CLI from this list, not a copied skill file, so it ships with
// the CLI it describes (#117); tests/aya-capabilities.test.mjs pins `aya help` to it.

export interface Capability {
  /** The subcommand words, e.g. "pane send". */
  command: string;
  /** Exactly the usage column of `aya help`. */
  usage: string;
  summary: string;
  example?: string;
  notes?: string[];
}

export const AYA_CAPABILITIES: readonly Capability[] = [
  {
    command: "open",
    usage: "aya open [path]",
    summary: "Open a directory as an Aya project, or focus it if already open.",
    example: 'aya open "$PWD"',
  },
  {
    command: "project open",
    usage: "aya project open [path]",
    summary: "Alias of `aya open`.",
  },
  {
    command: "focus",
    usage: "aya focus",
    summary: "Bring the Aya window to the front.",
  },
  {
    command: "notify",
    usage: "aya notify [--title title] body",
    summary: "Show a native notification; clicking it selects this pane.",
    example: 'aya notify --title "Aya" "Needs approval"',
  },
  {
    command: "status set",
    usage: "aya status set text",
    summary: "Show a short 'working on' status on this pane's tab.",
    example: 'aya status set "Running tests"',
    notes: ["Keep it to 2-6 words; set it on phase changes, not every command."],
  },
  {
    command: "status waiting",
    usage: "aya status waiting text",
    summary: "Mark this pane as blocked on the user.",
    example: 'aya status waiting "Needs approval"',
  },
  {
    command: "status done",
    usage: "aya status done text",
    summary: "Mark this pane's task as finished.",
    example: 'aya status done "Build passed"',
  },
  {
    command: "status error",
    usage: "aya status error text",
    summary: "Mark this pane's task as failed.",
    example: 'aya status error "Tests failed"',
  },
  {
    command: "status clear",
    usage: "aya status clear",
    summary: "Clear this pane's status.",
  },
  {
    command: "pane list",
    usage: "aya pane list [--project slug]",
    summary: "List the panes in this project by tab name and id; yours is marked (this pane).",
    notes: [
      "Run it first to learn the names and ids pane read / pane send take.",
      "Outside a pane it lists every project; --project lists one.",
    ],
  },
  {
    command: "pane read",
    usage: "aya pane read target [--project slug]",
    summary: "Print another pane's recent output as plain text, as its screen shows it, newest last.",
    example: 'aya pane read "reviewer"',
    notes: [
      "target is a pane name or an id from aya pane list; --project picks the project a name is looked up in.",
      "There is no 'wait until done': poll, and leave time between reads.",
    ],
  },
  {
    command: "pane send",
    usage: "aya pane send target [--no-submit] [--project slug] text",
    summary: "Type text into another pane and press Enter.",
    example: 'aya pane send "reviewer" "run the tests"',
    notes: [
      "target and --project work as in pane read.",
      "--no-submit types without pressing Enter, for a prompt the user should review first.",
      "Only drive a pane the user asked you to drive.",
    ],
  },
  {
    command: "team whoami",
    usage: "aya team whoami",
    summary: "Print this pane's team, role, who it sends to, what it must not do, and the protocol.",
    notes: ["Run it after a start, /clear or /resume: your role is not in your memory."],
  },
  {
    command: "team send",
    usage: "aya team send role text",
    summary: "Send a message to the pane playing role; the recipient sees who sent it, when, at which commit.",
    example: 'aya team send implementer "Round 5: the alert freezes at zero"',
    notes: ["Only roles listed in your send-to work.", "Written to the pane does not mean read."],
  },
  {
    command: "team inbox",
    usage: "aya team inbox",
    summary: "Print messages for your role that could not be typed into your pane.",
  },
  {
    command: "team pause",
    usage: 'aya team pause ["why"]',
    summary: "The lead ends the team's work: pauses it as the Pause button does, and the Teams window shows why; the user resumes it.",
    example: 'aya team pause "no lower complexity is possible"',
    notes: [
      "Only the lead (your whoami says so). Run it when the work is done or cannot go on, not to wait for the user: that is aya status waiting.",
      "A pause the user made is not the lead's to end, and a lead's pause the user Resumes or Pauses again becomes the user's.",
    ],
  },
  {
    command: "team new",
    usage: "aya team new [description]",
    summary: "Print a guide for writing a team file for this project: the format, its rules and an example; save the file with aya team save.",
    example: 'aya team new "a team that reviews and fixes the UX"',
    notes: ["Run it when the user asks for a team; look at the project before choosing roles."],
  },
  {
    command: "team save",
    usage: "aya team save [--replace] file|-",
    summary: "Check a team file and save it in Aya, as the Teams window's Save team does; - reads it from stdin.",
    example: "aya team save /tmp/ux-fix.md",
    notes: [
      "Prints each role and who it sends to, or the problem; a refused file saves nothing.",
      "An existing team needs --replace; ask the user first.",
    ],
  },
  {
    command: "team open",
    usage: "aya team open [--replace] team role=target...",
    summary:
      "Give roles of a saved team a pane in this project: target is a preset id (a new session of it), this (the pane you run in), or an existing pane's name or id. Roles not listed keep theirs; the team is not started.",
    example: "aya team open ux-fix reviewer=claude fixer=codex tester=this",
    notes: [
      "Propose the mapping to the user and wait for the user's yes before running it.",
      "Checks every role and target first; on a problem nothing is opened or assigned.",
      "Several roles can take the same preset: each gets its own new pane.",
      "A name that is both a preset id and a pane name is refused: write new:<preset> or pane:<name-or-id>.",
      "A role with a live pane, or a pane that plays another role, needs --replace; no pane is ever closed.",
    ],
  },
  {
    command: "team start",
    usage: 'aya team start team ["task"] [--to role]',
    summary:
      "Start a team as the Teams window's Start does: every role's pane is checked, then gets the delivery test; the team's rounds begin. A task then goes to --to, else the lead (the role with the cadence is the lead), else the first role, as a message from the user (from a role's pane: from that role).",
    example: 'aya team start ux-fix "make the timer pausable"',
    notes: [
      "Start a team only when the user asks for it; ask the user for the task first.",
      "Never run it to give a teammate work: that is aya team send. From a pane of one of the team's roles it is refused while the team runs, and on a pause the user made; the lead may resume only its own aya team pause.",
      "It prints who got the task.",
      "If a role's pane is missing or busy, nothing is sent and each such role is named.",
    ],
  },
  {
    command: "team debug",
    usage: "aya team debug team [-f]",
    summary: "Print the team's last 50 debug entries (every hold, round and its reason, queue, reservation, pause, liveness), -f to follow them; written only while aya debug is on.",
    notes: ["For the user debugging a team; set AYA_PROJECT_SLUG when the team's name is in two projects."],
  },
  {
    command: "team stats",
    usage: "aya team stats team [--json]",
    summary:
      "Print what Aya did for a team, read from its files with Aya open or closed: run time, messages per sender and receiver, rounds typed and skipped and why, holds by reason, redeliveries, messages still in an inbox, read marks, commits seen.",
    notes: ["Read-only. Rounds skipped, hold decisions, redeliveries and pauses come from the debug log: without aya debug on those rows say so instead of counting zero. Set AYA_PROJECT_SLUG when the team's name is in two projects."],
  },
  {
    command: "debug",
    usage: "aya debug on|off|status",
    summary: "Turn writing every team decision to the team's debug log on or off, with no restart; off by default.",
    notes: ["The user's switch: do not turn it on or off unless the user asks."],
  },
  {
    command: "presets",
    usage: "aya presets [--json]",
    summary: "List this Aya's presets: id, name, the agent it runs, and whether its CLI is installed.",
    notes: ["Run it before aya team open, to propose installed presets for the roles."],
  },
  {
    command: "capabilities",
    usage: "aya capabilities",
    summary: "Print this list as JSON.",
  },
  {
    command: "remote --stdio",
    usage: "aya remote --stdio",
    summary: "Transport for a remote Aya over SSH; not for use by agents.",
  },
];

export interface CapabilitiesDocument {
  /** True when the caller runs in an Aya pane (AYA_TERMINAL_ID reached us). */
  insideAya: boolean;
  terminalId?: string;
  commands: readonly Capability[];
  conventions: string[];
}

export function capabilitiesDocument(caller: {
  terminalId?: string;
}): CapabilitiesDocument {
  return {
    insideAya: Boolean(caller.terminalId),
    ...(caller.terminalId ? { terminalId: caller.terminalId } : {}),
    commands: AYA_CAPABILITIES,
    conventions: [
      "Panes are named by their Aya tab name, resolved within your own project; a name two panes share is rejected, not guessed.",
      "status and notify attach to your own pane through AYA_TERMINAL_ID, which Aya sets in every pane.",
      "Every command exits non-zero with the reason on stderr when Aya rejects it.",
    ],
  };
}
