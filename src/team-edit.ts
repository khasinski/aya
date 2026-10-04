// The team editor's model. Rows keep stable keys and links point at keys, so a
// rename, a cleared name or a removed row never leaves a stale link; role ids
// are resolved only when the team is built for Save or the preview.

import { MAX_CADENCE_MINUTES } from "./main-mirrors";
import { AYA_SENDER, USER_SENDER } from "./team-view";
import type { RoleDraft, TeamDefinition } from "./types";

export interface EditorRole {
  key: number;
  id: string;
  responsibilities: string;
  mustNot: string;
  sendsTo: { key: number; what: string }[];
}

export interface EditorTeam {
  name: string;
  roles: EditorRole[];
  /** The lead's row key; the rounds, if any, go to it. */
  lead: number | null;
  cadenceMinutes: number | null;
  protocol: string;
  /** "" for none: the field is optional and a blank one is left out of the file. */
  statusCommand: string;
  nextKey: number;
}

// The longest id electron/team-definition.ts ID_RE accepts; a test holds them equal.
export const ROLE_ID_MAX_LEN = 40;
// A new cadence (template or editor) runs this often until the user changes it.
export const DEFAULT_CADENCE_MINUTES = 30;

/** Why the team file would refuse this many round minutes, or null. */
export function cadenceProblem(minutes: number): string | null {
  return Number.isInteger(minutes) && minutes >= 1 && minutes <= MAX_CADENCE_MINUTES ? null : `Rounds run every 1-${MAX_CADENCE_MINUTES} min`;
}

/** Why the team would be refused without a lead, or null; a lead whose row has no name is none. */
export function leadProblem(t: EditorTeam): string | null {
  return fromEditor(t).lead === null ? "Pick the role that leads the team: it gets the task and the rounds, and checks nobody waits too long" : null;
}

export function setLead(t: EditorTeam, key: number | null): EditorTeam {
  return { ...t, lead: key };
}

export function setCadence(t: EditorTeam, minutes: number | null): EditorTeam {
  return { ...t, cadenceMinutes: minutes };
}

/** What the team file accepts as a role id: typing "Senior UX" gives "senior-ux". */
export function roleId(typed: string): string {
  return typed.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, ROLE_ID_MAX_LEN);
}

/** Why main would refuse the role id, or null; a test holds the words equal. */
export function roleIdProblem(id: string): string | null {
  if (id === AYA_SENDER) return `"${AYA_SENDER}" is reserved for Aya's own messages; name the role something else`;
  return id === USER_SENDER ? `"${USER_SENDER}" is reserved for the user's own messages; name the role something else` : null;
}

export function toEditor(team: TeamDefinition): EditorTeam {
  const key = new Map(team.roles.map((r, i) => [r.id, i]));
  return {
    name: team.name,
    roles: team.roles.map((r, i) => ({
      key: i,
      id: r.id,
      responsibilities: r.responsibilities,
      mustNot: r.mustNot,
      sendsTo: r.sendsTo.filter((s) => key.has(s.to)).map((s) => ({ key: key.get(s.to) as number, what: s.what })),
    })),
    lead: team.lead !== null && key.has(team.lead) ? (key.get(team.lead) as number) : null,
    cadenceMinutes: team.cadenceMinutes,
    protocol: team.protocol,
    statusCommand: team.statusCommand ?? "",
    nextKey: team.roles.length,
  };
}

/** Links to a removed or unnamed row are left out. */
export function fromEditor(t: EditorTeam): TeamDefinition {
  const id = new Map(t.roles.filter((r) => r.id).map((r) => [r.key, r.id]));
  return {
    name: t.name,
    roles: t.roles.map((r) => ({
      id: r.id,
      sendsTo: r.sendsTo.filter((s) => id.has(s.key)).map((s) => ({ to: id.get(s.key) as string, what: s.what.trim() })),
      mustNot: r.mustNot,
      responsibilities: r.responsibilities,
    })),
    lead: t.lead !== null && id.has(t.lead) ? (id.get(t.lead) as string) : null,
    cadenceMinutes: t.cadenceMinutes,
    protocol: t.protocol,
    ...(t.statusCommand.trim() ? { statusCommand: t.statusCommand.trim() } : {}),
  };
}

export function addRole(t: EditorTeam): EditorTeam {
  const role: EditorRole = { key: t.nextKey, id: "", responsibilities: "", mustNot: "", sendsTo: [] };
  return { ...t, roles: [...t.roles, role], nextKey: t.nextKey + 1 };
}

/** Links left pointing at the row are dropped by fromEditor; keys are never reused. */
export function removeRole(t: EditorTeam, key: number): EditorTeam {
  return { ...t, roles: t.roles.filter((r) => r.key !== key), lead: t.lead === key ? null : t.lead };
}

export function updateRole(t: EditorTeam, key: number, patch: Partial<Omit<EditorRole, "key" | "sendsTo">>): EditorTeam {
  return { ...t, roles: t.roles.map((r) => (r.key === key ? { ...r, ...patch } : r)) };
}

/** Ticks (`on`) or unticks the route from one row to another; `what` sets its text. */
export function setSend(t: EditorTeam, from: number, to: number, on: boolean, what?: string): EditorTeam {
  return {
    ...t,
    roles: t.roles.map((r) => {
      if (r.key !== from) return r;
      const rest = r.sendsTo.filter((s) => s.key !== to);
      if (!on) return { ...r, sendsTo: rest };
      const old = r.sendsTo.find((s) => s.key === to);
      const text = (what ?? old?.what ?? "").replace(/[()\n]/g, "");
      return { ...r, sendsTo: old ? r.sendsTo.map((s) => (s.key === to ? { key: to, what: text } : s)) : [...r.sendsTo, { key: to, what: text }] };
    }),
  };
}

/** A draft for one row, by key; routes to ids no row has are dropped. */
export function applyDraft(t: EditorTeam, key: number, draft: RoleDraft): EditorTeam {
  const byId = new Map(t.roles.filter((r) => r.id).map((r) => [r.id, r.key]));
  const sendsTo = draft.sendsTo.filter((s) => byId.has(s.to)).map((s) => ({ key: byId.get(s.to) as number, what: s.what }));
  return {
    ...t,
    roles: t.roles.map((r) =>
      r.key === key ? { ...r, responsibilities: draft.responsibilities, mustNot: draft.mustNot, sendsTo } : r,
    ),
  };
}
