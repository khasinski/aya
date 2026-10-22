import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { DEFAULT_CADENCE_MINUTES } from "../team-edit";
import { paneRoles } from "../team-view";
import type { AyaIntelligenceConfig, PresetChoice, ProjectConfig, TeamDefinition, TeamSummary, WaitingPanes } from "../types";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";
import { TeamCard } from "./TeamCard";
import { TeamEditor } from "./TeamEditor";
import { ErrorLine, useAsyncAction } from "./use-async-action";

// While open, the log and assignments refresh at this pace.
const REFRESH_MS = 3000;

/** The pair that ran the game project's 22-round UX review. */
const TWO_ROLE_TEMPLATE: TeamDefinition = {
  name: "review",
  roles: [
    {
      id: "reviewer",
      sendsTo: [{ to: "implementer", what: "findings with the screen state as proof" }],
      mustNot: "edit code",
      responsibilities:
        "Checks the running app each round and reports what a user would get wrong, with the screen state as proof.",
    },
    {
      id: "implementer",
      sendsTo: [{ to: "reviewer", what: "answers and the commit to check" }],
      mustNot: "leave a report unanswered",
      responsibilities: "Fixes findings, answers every report, and names the commit to check.",
    },
  ],
  lead: "reviewer",
  cadenceMinutes: DEFAULT_CADENCE_MINUTES,
  protocol:
    "Findings are hypotheses with a measurement request, not facts. Number your reports as updates (Update 1, Update 2) and mark items [reported -> confirmed]. Reports are one-way unless a question is asked.",
};

// The first team's log gives up height down to this, so its card fits the dialog.
const LOG_MIN_PX = 120;
// Within this many px of its bottom, the log counts as showing its newest message (as TeamChat's).
const LOG_AT_BOTTOM_PX = 24;

/** The role notes come in seconds after the dialog opens (on a slow machine before it first
 *  paints) and grow the card above its log, so the newest message, a held one included, went below
 *  the dialog's edge. The first team's log now shrinks so its card fits the dialog, down to
 *  LOG_MIN_PX, and keeps showing its newest message: the team's name, status and newest message
 *  show together, and the dialog itself never scrolls on its own. */
function useFitFirstLog(body: RefObject<HTMLDivElement | null>, contentKey: unknown) {
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const fit = () => {
      const log = el.querySelector<HTMLElement>('[role="log"]');
      const card = log?.closest<HTMLElement>(".aya-teams-card");
      if (!log || !card) return;
      const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < LOG_AT_BOTTOM_PX;
      log.style.maxHeight = "";
      const natural = parseFloat(getComputedStyle(log).maxHeight);
      // "Full height": the log takes what it needs and the dialog scrolls.
      if (Number.isNaN(natural)) return;
      const rest = card.getBoundingClientRect().height - log.getBoundingClientRect().height;
      const above = card.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
      const room = Math.floor(el.clientHeight - above - rest);
      log.style.maxHeight = `${Math.min(natural, Math.max(LOG_MIN_PX, room))}px`;
      if (atBottom) log.scrollTop = log.scrollHeight;
    };
    const resized = new ResizeObserver(fit);
    resized.observe(el);
    for (const child of el.children) resized.observe(child);
    return () => resized.disconnect();
  }, [body, contentKey]);
}

interface Props {
  project: ProjectConfig;
  intelligence: AyaIntelligenceConfig;
  waiting: WaitingPanes;
  onClose: () => void;
  /** Restart terminal for a pane of this window: offered where a restart gives a role its note. */
  onRestartPane?: (paneId: string) => Promise<void>;
}

export function TeamsModal({ project, intelligence, waiting, onClose, onRestartPane }: Props) {
  const [teams, setTeams] = useState<TeamSummary[]>([]);
  const [editing, setEditing] = useState<{ team: TeamDefinition; isNew: boolean } | null>(null);
  const [presets, setPresets] = useState<PresetChoice[]>([]);
  const list = useAsyncAction();
  const { run } = list;
  const body = useRef<HTMLDivElement>(null);
  useFitFirstLog(body, editing ? null : teams.map((t) => t.name).join("\n"));

  const reload = useCallback(async () => {
    const next = await run(() => window.aya.teamList(project.slug));
    if (next) setTeams(next);
  }, [project.slug, run]);

  useEffect(() => {
    void window.aya
      .teamPresets()
      .then(setPresets)
      .catch(() => {});
  }, []);

  useEffect(() => {
    void reload();
    const id = window.setInterval(() => void reload(), REFRESH_MS);
    return () => window.clearInterval(id);
  }, [reload]);

  return (
    <div
      className="aya-modal-backdrop"
      onMouseDown={markBackdropMouseDown}
      onClick={(e) => closeFromBackdropClick(e, onClose)}
    >
      <section
        className="aya-modal aya-teams-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Teams"
        onClick={(e) => e.stopPropagation()}
      >
        {editing ? (
          <div className="aya-teams-body">
          <TeamEditor
            initial={editing.team}
            isNew={editing.isNew}
            intelligence={intelligence}
            onCancel={() => setEditing(null)}
            onSave={async (team) => {
              await window.aya.teamSave(project.slug, team, editing.isNew);
              setEditing(null);
              await reload();
            }}
          />
          </div>
        ) : (
          <>
            <div className="aya-modal-title">Teams · {project.name}</div>
            <div className="aya-modal-hint">
              Defined by the project. Which pane plays which role stays on this machine.
            </div>
            <ErrorLine error={list.error} />
            {/* Only the cards scroll: the title and the buttons stay on screen. */}
            <div ref={body} className="aya-teams-body">
            {teams.length === 0 && <div className="aya-modal-hint">No team yet.</div>}
            {teams.map((team) => (
              <TeamCard
                key={team.name}
                team={team}
                project={project}
                installed={presets.filter((p) => p.installed)}
                presetNames={Object.fromEntries(presets.map((p) => [p.id, p.name]))}
                plays={paneRoles(teams)}
                waiting={waiting}
                onEdit={(definition) => setEditing({ team: definition, isNew: false })}
                onChanged={reload}
                onRestartPane={onRestartPane}
              />
            ))}
            </div>
            <div className="aya-modal-actions">
              <button
                className="aya-modal-btn"
                onClick={() => setEditing({ team: { ...TWO_ROLE_TEMPLATE, name: "" }, isNew: true })}
              >
                New team
              </button>
              <button className="aya-modal-btn aya-modal-btn--primary" onClick={onClose}>
                Close
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
