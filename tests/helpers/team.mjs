import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** A project "game" in a temp root, with an Aya home beside it. `teamFile`, if
 *  given, is its .aya/teams/ux-review.md; without one the project has no teams dir. */
/** `saved: false` leaves the repo file unsaved in Aya, as a fresh clone has it. */
export function teamProject(prefix, { teamFile, tabs = [{ id: "pane-t" }, { id: "pane-i" }], saved = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const directory = join(root, "game");
  mkdirSync(directory);
  if (teamFile !== undefined) {
    mkdirSync(join(directory, ".aya", "teams"), { recursive: true });
    writeFileSync(join(directory, ".aya", "teams", "ux-review.md"), teamFile);
    if (saved) {
      mkdirSync(join(root, "aya", "teams", "game", "ux-review"), { recursive: true });
      writeFileSync(join(root, "aya", "teams", "game", "ux-review", "saved.md"), teamFile);
    }
  }
  return {
    root,
    directory,
    teamHome: join(root, "aya"),
    project: { slug: "game", name: "game", directory, tabs },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
