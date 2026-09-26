// Per harness: panes launched vs panes that ever called `aya` (#117 point 4).
// Only first sightings are written, so the file changes rarely.

import { mkdirSync, promises as fs, renameSync, writeFileSync } from "node:fs";
import * as path from "node:path";

/** Oldest panes are dropped past this, so the file stays small forever. */
export const CLI_ADOPTION_MAX_PANES = 2000;

export interface PaneAdoption {
  agent?: string;
  presetId?: string;
  launchedAt?: number;
  firstCallAt?: number;
  /** Control request types this pane has sent, first-seen order. */
  commands?: string[];
}

export interface CliAdoptionState {
  version: 1;
  panes: Record<string, PaneAdoption>;
}

export const emptyCliAdoption = (): CliAdoptionState => ({ version: 1, panes: {} });

/** Accept whatever is on disk; anything malformed starts over rather than
 *  failing the app. */
export function normalizeCliAdoption(value: unknown): CliAdoptionState {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { version?: unknown }).version !== 1
  ) {
    return emptyCliAdoption();
  }
  const panes = (value as { panes?: unknown }).panes;
  if (typeof panes !== "object" || panes === null || Array.isArray(panes)) {
    return emptyCliAdoption();
  }
  const out: Record<string, PaneAdoption> = {};
  for (const [id, raw] of Object.entries(panes)) {
    if (typeof raw !== "object" || raw === null) continue;
    const p = raw as Record<string, unknown>;
    const pane: PaneAdoption = {};
    if (typeof p.agent === "string") pane.agent = p.agent;
    if (typeof p.presetId === "string") pane.presetId = p.presetId;
    if (typeof p.launchedAt === "number") pane.launchedAt = p.launchedAt;
    if (typeof p.firstCallAt === "number") pane.firstCallAt = p.firstCallAt;
    if (Array.isArray(p.commands)) {
      pane.commands = p.commands.filter((c): c is string => typeof c === "string");
    }
    out[id] = pane;
  }
  return { version: 1, panes: out };
}

function pruned(state: CliAdoptionState): CliAdoptionState {
  const ids = Object.keys(state.panes);
  if (ids.length <= CLI_ADOPTION_MAX_PANES) return state;
  const seen = (p: PaneAdoption) => p.launchedAt ?? p.firstCallAt ?? 0;
  const keep = ids
    .sort((a, b) => seen(state.panes[b]) - seen(state.panes[a]))
    .slice(0, CLI_ADOPTION_MAX_PANES);
  return { version: 1, panes: Object.fromEntries(keep.map((id) => [id, state.panes[id]])) };
}

/** A pane was launched (or re-attached). Returns null when nothing changed. */
export function recordLaunch(
  state: CliAdoptionState,
  launch: { terminalId: string; agent?: string; presetId?: string },
  now: number,
): CliAdoptionState | null {
  const prior = state.panes[launch.terminalId];
  const next: PaneAdoption = {
    ...prior,
    launchedAt: prior?.launchedAt ?? now,
    ...(launch.agent ? { agent: launch.agent } : {}),
    ...(launch.presetId ? { presetId: launch.presetId } : {}),
  };
  if (
    prior &&
    prior.launchedAt !== undefined &&
    prior.agent === next.agent &&
    prior.presetId === next.presetId
  ) {
    return null;
  }
  return pruned({ version: 1, panes: { ...state.panes, [launch.terminalId]: next } });
}

/** A control request arrived from a pane. Returns null when nothing changed. */
export function recordCall(
  state: CliAdoptionState,
  call: { terminalId: string; presetId?: string; command: string },
  now: number,
): CliAdoptionState | null {
  const prior = state.panes[call.terminalId] ?? {};
  const commands = prior.commands ?? [];
  if (prior.firstCallAt !== undefined && commands.includes(call.command)) {
    return null;
  }
  const next: PaneAdoption = {
    ...prior,
    firstCallAt: prior.firstCallAt ?? now,
    commands: commands.includes(call.command) ? commands : [...commands, call.command],
    ...(prior.presetId || !call.presetId ? {} : { presetId: call.presetId }),
  };
  return pruned({ version: 1, panes: { ...state.panes, [call.terminalId]: next } });
}

export interface HarnessAdoption {
  /** AgentKind of the pane, "unknown" when Aya never saw it launch. */
  agent: string;
  panesLaunched: number;
  panesThatCalledAya: number;
  panesThatRanCapabilities: number;
}

export function summarizeCliAdoption(state: CliAdoptionState): HarnessAdoption[] {
  const byAgent = new Map<string, HarnessAdoption>();
  for (const pane of Object.values(state.panes)) {
    const agent = pane.agent ?? "unknown";
    const row = byAgent.get(agent) ?? {
      agent,
      panesLaunched: 0,
      panesThatCalledAya: 0,
      panesThatRanCapabilities: 0,
    };
    if (pane.launchedAt !== undefined) row.panesLaunched += 1;
    if (pane.firstCallAt !== undefined) row.panesThatCalledAya += 1;
    if (pane.commands?.includes("capabilities")) row.panesThatRanCapabilities += 1;
    byAgent.set(agent, row);
  }
  return [...byAgent.values()].sort(
    (a, b) => b.panesLaunched - a.panesLaunched || a.agent.localeCompare(b.agent),
  );
}

/** File-backed store: loads once, writes a debounced atomic snapshot. */
export function createCliAdoptionStore(file: string, debounceMs = 2_000) {
  let state: CliAdoptionState | null = null;
  let loading: Promise<CliAdoptionState> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const load = () => {
    loading ??= fs
      .readFile(file, "utf-8")
      .then((raw) => normalizeCliAdoption(JSON.parse(raw)))
      .catch(() => emptyCliAdoption())
      .then((loaded) => (state ??= loaded));
    return loading;
  };
  // Sync, because before-quit does not wait for a promise. No-op when clean.
  const flush = () => {
    if (!timer || !state) return;
    clearTimeout(timer);
    timer = null;
    const tmp = `${file}.${process.pid}.tmp`;
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(tmp, file);
  };
  const apply = async (
    change: (current: CliAdoptionState) => CliAdoptionState | null,
  ) => {
    // The live state, not load()'s resolved value: a concurrent apply may
    // already have replaced it.
    await load();
    const next = change(state!);
    if (!next) return;
    state = next;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        flush();
      } catch (err) {
        console.warn("[aya] cli-adoption write failed:", err);
      }
    }, debounceMs);
    timer.unref?.();
  };

  return {
    launched: (launch: Parameters<typeof recordLaunch>[1]) =>
      apply((s) => recordLaunch(s, launch, Date.now())),
    called: (call: Parameters<typeof recordCall>[1]) =>
      apply((s) => recordCall(s, call, Date.now())),
    summary: async () => {
      await load();
      return summarizeCliAdoption(state!);
    },
    flush,
  };
}
