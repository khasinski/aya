// Settings IPC: presets, snippets, terminal themes (with import), the Omarchy palette, monitored sessions, and
// Aya Intelligence (local summaries, Ollama status and model pull).

import { promises as fs } from "node:fs";
import * as path from "node:path";
import type { BrowserWindow, Dialog, IpcMain, IpcMainInvokeEvent } from "electron";
import { scanHarnesses } from "../harnesses";
import { readOmarchyStatus, readOmarchyTheme } from "../omarchy";
import { listPresets, savePresets } from "../presets";
import { listMonitoredSessions } from "../session-monitor";
import { listSnippets, saveSnippets } from "../snippets";
import { validatePresetArray, validateSnippetArray, validateThemesFile } from "../validation";

export interface SettingsIpcDeps {
  ipcMain: Pick<IpcMain, "handle">;
  senderWindow: (e: IpcMainInvokeEvent) => BrowserWindow | null;
  dialog: Pick<Dialog, "showOpenDialog">;
  /** The user's home, where the theme picker starts. */
  home: () => string;
  /** After presets are saved: the Antigravity brief follows their opt-in. */
  presetsSaved: () => Promise<void>;
  intelligence: {
    /** Validates the renderer's request, then summarizes it. */
    summarize: (req: unknown) => Promise<unknown>;
    ollamaStatus: (model?: string) => Promise<unknown>;
    /** Validates the model name, then pulls it. */
    pullOllamaModel: (model: unknown) => Promise<unknown>;
  };
}

export function registerSettingsIpc(deps: SettingsIpcDeps): void {
  const { ipcMain } = deps;
  ipcMain.handle("presets:list", async () => listPresets());
  ipcMain.handle("presets:save", async (_e, presets: unknown) => {
    await savePresets(validatePresetArray(presets));
    await deps.presetsSaved();
  });
  ipcMain.handle("presets:scan-harnesses", async () => scanHarnesses());

  ipcMain.handle("snippets:list", async () => listSnippets());
  ipcMain.handle("snippets:save", async (_e, snippets: unknown) =>
    saveSnippets(validateSnippetArray(snippets)),
  );

  ipcMain.handle("local-summary:summarize", async (_e, req: unknown) => deps.intelligence.summarize(req));
  ipcMain.handle("intelligence:ollama-status", async (_e, model: unknown) =>
    deps.intelligence.ollamaStatus(typeof model === "string" && model.trim() ? model.trim() : undefined),
  );
  ipcMain.handle("intelligence:pull-ollama-model", async (_e, model: unknown) =>
    deps.intelligence.pullOllamaModel(model),
  );

  // Omarchy theme integration (Linux): the renderer skins chrome + terminal from
  // the current Omarchy palette, and a watcher in main pushes live switches.
  ipcMain.handle("omarchy:status", async () => readOmarchyStatus());
  ipcMain.handle("omarchy:read", async () => readOmarchyTheme());
  ipcMain.handle("sessions:list-monitored", async () => listMonitoredSessions());

  ipcMain.handle("themes:list", async () => {
    const { loadThemes } = await import("../themes");
    return loadThemes();
  });
  ipcMain.handle("themes:save", async (_e, file: unknown) => {
    const { saveThemes } = await import("../themes");
    return saveThemes(validateThemesFile(file));
  });
  ipcMain.handle("themes:import", async (e) => {
    const { parseTheme } = await import("../themes");
    const win = deps.senderWindow(e);
    const options = {
      title: "Import terminal theme",
      defaultPath: deps.home(),
      properties: ["openFile" as const],
      filters: [
        {
          name: "Terminal themes (.itermcolors, .json)",
          extensions: ["itermcolors", "json"],
        },
        { name: "iTerm2 colors", extensions: ["itermcolors"] },
        { name: "Windows Terminal JSON", extensions: ["json"] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await deps.dialog.showOpenDialog(win, options)
      : await deps.dialog.showOpenDialog(options);
    if (result.canceled || result.filePaths.length === 0) return null;
    const filePath = result.filePaths[0];
    const content = await fs.readFile(filePath, "utf-8");
    const fallbackName = path.basename(filePath, path.extname(filePath));
    return parseTheme(content, fallbackName);
  });
}
