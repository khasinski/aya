import {
  COLUMN_TITLES,
  DEFAULT_BOARD_COLUMNS,
  PENDING_COLUMN_IDS,
  STARTED_COLUMN_ID,
} from "../../../shared/board-columns.cjs";
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
const pendingTitles = PENDING_COLUMN_IDS.map((id) => COLUMN_TITLES[id]).join(" or ");

/** The board's defaults, fixed rules and limits, read only. Shown while the Kanban board (General) is on.
 *  The fixed rules are enforced by electron/board.ts and cannot be turned off. */
export function KanbanTab() {
  return (
    <section className="aya-settings-pane" data-testid="settings-kanban">
      <SettingsHeader icon="view_kanban" title="Kanban">
        What every project board starts with. These cannot be changed here yet.
      </SettingsHeader>
      <div className="aya-settings-general">
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
          <li>Moving a claimed card back to {pendingTitles} removes its claim and asks its pane to stop work on it.</li>
          <li>Starting a card from {pendingTitles} moves it to {COLUMN_TITLES[STARTED_COLUMN_ID]}, when the board has that column.</li>
          <li>A card another pane holds is taken over only by Send to pane on the board or aya board claim with --replace.</li>
          <li>From a pane, aya board releases only that pane&apos;s cards unless --force is given.</li>
          <li>Taking over, releasing, deleting or archiving a claimed card asks the pane that held it to stop work on it, unless that pane made the change.</li>
          <li>Closing a terminal tab releases every card it held.</li>
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
