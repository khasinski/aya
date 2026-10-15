export function terminalKillRefusal(action: "restart" | "close", name: string, error: unknown, subject: "pane" | "project" = "pane"): string {
  const why = error instanceof Error ? error.message : String(error);
  return `Aya did not ${action} ${name}: it could not confirm that ${subject === "project" ? "its terminals" : "the old terminal"} stopped, so the ${subject} was kept. Check the terminal host in Settings > Diagnostics before trying again.\n\n${why}`;
}
