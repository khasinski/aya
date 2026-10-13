import type { Rect } from "./split-tree";
import type { ProjectConfig } from "./types";

export function paneStyleFromRect(isSplit: boolean, rect: Rect) {
  return isSplit
    ? {
        left: `${rect.left}%`,
        top: `${rect.top}%`,
        width: `${rect.width}%`,
        height: `${rect.height}%`,
      }
    : undefined;
}

export function emptyProjectPaneTitle(project: ProjectConfig): string {
  return project.remote
    ? `Remote project on ${project.remote.label}`
    : "No terminals yet — launch one to get started.";
}
