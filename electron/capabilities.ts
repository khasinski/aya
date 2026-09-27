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
    usage: "aya pane list",
    summary: "List the panes in this project by tab name; yours is marked (this pane).",
    notes: ["Run it first to learn the names pane read / pane send take."],
  },
  {
    command: "pane read",
    usage: "aya pane read name",
    summary: "Print another pane's recent output, newest last.",
    example: 'aya pane read "reviewer"',
    notes: ["There is no 'wait until done': poll, and leave time between reads."],
  },
  {
    command: "pane send",
    usage: "aya pane send name [--no-submit] text",
    summary: "Type text into another pane and press Enter.",
    example: 'aya pane send "reviewer" "run the tests"',
    notes: [
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
