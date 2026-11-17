import { useEffect, useState } from "react";
import { COLUMN_IDS, COLUMN_TITLES, DEFAULT_BOARD_COLUMNS, FIXED_RULES } from "../../../shared/board-columns.cjs";
import {
  MAX_ASSIGNEE_CHARS,
  MAX_BOARD_CARDS,
  MAX_BOARD_COLUMNS,
  MAX_BOARD_IMAGE_BYTES,
  MAX_CARD_DESCRIPTION_CHARS,
  MAX_CARD_LABEL_CHARS,
  MAX_CARD_LABELS,
  MAX_CARD_TITLE_CHARS,
  MAX_COLUMN_TITLE_CHARS,
} from "../../main-mirrors";
import { mib } from "../../units";
import { PRIORITY_OPTIONS } from "../useKanbanBoard";
import { SettingsHeader, SettingsRow } from "./parts";

const value = (text: string) => <span className="aya-modal-hint">{text}</span>;
const count = (n: number) => n.toLocaleString("en-US");

/** The board's option, defaults, fixed rules and limits. Shown while the Kanban board (General) is on.
 *  Only where the Backlog column shows can be changed; the fixed rules are enforced by electron/board.ts. */
export function KanbanTab({ backlogEnabled, onBacklogEnabledChange, project }: {
  backlogEnabled: boolean;
  onBacklogEnabledChange: (enabled: boolean) => void;
  /** The project whose board Create backlog column adds to; null when there is none. */
  project: { slug: string; name: string } | null;
}) {
  const projectSlug = project?.slug ?? null;
  // Whether the current project's board has a Backlog column; null until known.
  const [hasBacklogColumn, setHasBacklogColumn] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    setHasBacklogColumn(null);
    if (!projectSlug) return;
    void window.aya.getBoard(projectSlug)
      .then((board) => { if (live) setHasBacklogColumn(board.columns.some((c) => c.id === COLUMN_IDS.backlog)); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [projectSlug]);
  const createBacklogColumn = () => {
    if (!projectSlug) return;
    void window.aya.addBoardColumn({ projectSlug, title: COLUMN_TITLES[COLUMN_IDS.backlog] })
      .then((board) => setHasBacklogColumn(board.columns.some((c) => c.id === COLUMN_IDS.backlog)))
      .catch(() => undefined);
  };
  return (
    <section className="aya-settings-pane" data-testid="settings-kanban">
      <SettingsHeader icon="view_kanban" title="Kanban">
        What every project board starts with. Only the setting below can be changed here.
      </SettingsHeader>
      <div className="aya-settings-general">
        <SettingsRow
          icon="inventory_2"
          title="Move backlog to shelf"
          control={(
            <div className="aya-settings-button-row">
              <span className="aya-settings-kanban-create">
                <button
                  type="button"
                  className="aya-modal-btn"
                  disabled={hasBacklogColumn !== false}
                  onClick={createBacklogColumn}
                >
                  Create backlog column
                </button>
                {project && <span className="aya-settings-kanban-create-note">Creates the Backlog column in {project.name}</span>}
              </span>
              <div className="aya-settings-segmented" aria-label="Move backlog to shelf">
                {([[true, "On"], [false, "Off"]] as const).map(([enabled, label]) => (
                  <button
                    key={label}
                    type="button"
                    disabled={hasBacklogColumn !== true}
                    className={`aya-settings-segment ${backlogEnabled === enabled ? "aya-settings-segment--active" : ""}`}
                    onClick={() => onBacklogEnabledChange(enabled)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>
          )}
        >
          Shows the board's Backlog column in the shelf instead of on the board. Needs a Backlog column.
        </SettingsRow>
        <SettingsRow icon="view_column" title="Columns on a new board" control={value(DEFAULT_BOARD_COLUMNS.map((column) => column.title).join(", "))}>
          Add, rename and reorder columns on the board itself.
        </SettingsRow>
        <SettingsRow icon="add_card" title="New cards" control={value("First column")}>
          A card added without a column goes into the board's first column.
        </SettingsRow>
        <SettingsRow
          icon="flag"
          title="Priority"
          control={value(PRIORITY_OPTIONS.map((option) => `${option.label} (${option.short})`).join(", "))}
        >
          Optional on each card.
        </SettingsRow>
      </div>
      <section className="aya-settings-box" aria-label="Kanban fixed rules">
        <h3>Fixed rules</h3>
        <ul>
          {FIXED_RULES.map((rule) => <li key={rule}>{rule}</li>)}
        </ul>
      </section>
      <section className="aya-settings-box" aria-label="Kanban limits">
        <h3>Limits</h3>
        <ul>
          <li>A board holds up to {count(MAX_BOARD_COLUMNS)} columns and {count(MAX_BOARD_CARDS)} cards.</li>
          <li>Card title: up to {count(MAX_CARD_TITLE_CHARS)} characters. Column title: up to {count(MAX_COLUMN_TITLE_CHARS)} characters.</li>
          <li>Card description: up to {count(MAX_CARD_DESCRIPTION_CHARS)} characters.</li>
          <li>Labels: up to {count(MAX_CARD_LABELS)} per card, {count(MAX_CARD_LABEL_CHARS)} characters each.</li>
          <li>Assignee: up to {count(MAX_ASSIGNEE_CHARS)} characters.</li>
          <li>Images in a card: up to {mib(MAX_BOARD_IMAGE_BYTES)} MiB each.</li>
        </ul>
      </section>
    </section>
  );
}
