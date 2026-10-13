import { useEffect, type Dispatch, type SetStateAction } from "react";
import type { Preset, Snippet, Theme } from "../types";

interface ConfigReloadOptions {
  setSnippets: Dispatch<SetStateAction<Snippet[]>>;
  setPresets: Dispatch<SetStateAction<Preset[]>>;
  setThemes: Dispatch<SetStateAction<Theme[]>>;
  setActiveThemeId: Dispatch<SetStateAction<string>>;
  reloadProjects: () => void;
}

export function useConfigReload({
  setSnippets,
  setPresets,
  setThemes,
  setActiveThemeId,
  reloadProjects,
}: ConfigReloadOptions) {
  // Reload config when one of the user-editable files under ~/.aya/ is edited while
  // Aya is running. Without this, an edit made by hand to snippets/presets/themes.json
  // would be overwritten by the next save in the app
  useEffect(() => {
    return window.aya.onConfigChange(({ slice }) => {
      if (slice === "snippets") {
        void window.aya
          .listSnippets()
          .then(setSnippets)
          .catch((e) =>
            console.warn(
              "config hot-reload (snippets) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "presets") {
        void window.aya
          .listPresets()
          .then(setPresets)
          .catch((e) =>
            console.warn(
              "config hot-reload (presets) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "themes") {
        void window.aya
          .listThemes()
          .then((file) => {
            setThemes(file.themes);
            setActiveThemeId(file.activeId);
          })
          .catch((e) =>
            console.warn(
              "config hot-reload (themes) failed; keeping current state",
              e,
            ),
          );
      } else if (slice === "projects") {
        reloadProjects();
      }
    });
  }, [setSnippets, setPresets, setThemes, setActiveThemeId, reloadProjects]);
}
