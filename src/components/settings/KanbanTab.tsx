import { DEFAULT_BOARD_COLUMN_TITLES, MAX_CARD_DESCRIPTION_CHARS } from "../../main-mirrors";
import { PRIORITY_OPTIONS } from "../useKanbanBoard";
import { SettingsHeader, SettingsRow } from "./parts";

const value = (text: string) => <span className="aya-modal-hint">{text}</span>;

/** The board's defaults, read only. Shown while the Kanban board (General) is on. */
export function KanbanTab() {
  return (
    <section className="aya-settings-pane" data-testid="settings-kanban">
      <SettingsHeader icon="view_kanban" title="Kanban">
        What every project board starts with. These cannot be changed here yet.
      </SettingsHeader>
      <div className="aya-settings-general">
        <SettingsRow icon="view_column" title="Columns on a new board" control={value(DEFAULT_BOARD_COLUMN_TITLES.join(", "))}>
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
        <SettingsRow
          icon="notes"
          title="Card description"
          control={value(`Up to ${MAX_CARD_DESCRIPTION_CHARS.toLocaleString("en-US")} characters`)}
        />
      </div>
    </section>
  );
}
