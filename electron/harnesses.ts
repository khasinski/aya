// Detect agent CLIs installed on the user's PATH so the first-launch
// preset list contains only what's actually usable, and so Settings can
// suggest harnesses the user hasn't added yet.
//
// All probes run through `/bin/bash -lc 'command -v <bin>'` so login-shell
// PATH (mise, asdf, brew, etc.) is respected — otherwise we'd miss
// binaries installed via version managers.

import { exec } from "node:child_process";

export interface HarnessDef {
  /** Canonical id; used as the preset id when seeded. */
  id: string;
  /** Binary name on PATH (no flags). */
  binary: string;
  name: string;
  icon: string;
  color: string;
  /** Default launch command. Plain binary in v1; user can edit later. */
  command: string;
}

/** Known agent harnesses + interactive AI CLIs we'll probe for. Add new
 *  ones here as the ecosystem grows. */
export const KNOWN_HARNESSES: readonly HarnessDef[] = [
  {
    id: "claude",
    binary: "claude",
    name: "Claude Code",
    icon: "✻",
    color: "#d97757",
    command: "claude",
  },
  {
    id: "codex",
    binary: "codex",
    name: "Codex",
    icon: "◆",
    color: "#10a37f",
    command: "codex",
  },
  {
    id: "aider",
    binary: "aider",
    name: "Aider",
    icon: "A",
    color: "#f0ad4e",
    command: "aider",
  },
  {
    id: "gemini",
    binary: "gemini",
    name: "Gemini",
    icon: "G",
    color: "#4285f4",
    command: "gemini",
  },
  {
    id: "opencode",
    binary: "opencode",
    name: "OpenCode",
    icon: "O",
    color: "#8957e5",
    command: "opencode",
  },
  {
    id: "amp",
    binary: "amp",
    name: "Amp",
    icon: "Λ",
    color: "#3b78ff",
    command: "amp",
  },
  {
    id: "crush",
    binary: "crush",
    name: "Crush",
    icon: "C",
    color: "#ff7b72",
    command: "crush",
  },
];

/** Filter the binary name through a strict allow-list before interpolating
 *  into the shell. Defense against accidentally executing shell metachars
 *  if the KNOWN_HARNESSES list ever picks up a weird entry. */
function safeBinaryName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_.-]/g, "");
}

async function commandExists(binary: string): Promise<boolean> {
  const safe = safeBinaryName(binary);
  if (!safe) return false;
  return new Promise((resolve) => {
    exec(
      `/bin/bash -lc 'command -v ${safe} >/dev/null 2>&1'`,
      { timeout: 2500, windowsHide: true },
      (err) => resolve(err === null),
    );
  });
}

/** Probe every known harness in parallel; return the subset present on
 *  the user's PATH. Total time bounded by the slowest single probe. */
export async function scanHarnesses(): Promise<HarnessDef[]> {
  const checks = await Promise.all(
    KNOWN_HARNESSES.map(async (h) => ({ h, found: await commandExists(h.binary) })),
  );
  return checks.filter((x) => x.found).map((x) => x.h);
}
