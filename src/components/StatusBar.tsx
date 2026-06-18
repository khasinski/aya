import { useEffect, useMemo, useRef, useState } from "react";
import hljs from "highlight.js/lib/common";
import type { GitChangedFile, ProjectConfig, TerminalState } from "../types";

// Material Symbols small icon size (px) used for status-bar glyphs
const ICON_SIZE_SM_PX = 13;

interface GitInfo {
  branch: string | null;
  dirty: number;
}

interface Props {
  project: ProjectConfig | null;
  git: GitInfo | null;
  terminal: TerminalState | null;
  attentionCount: number;
  snippetsOpen: boolean;
  snippetsDisabled: boolean;
  onOpenProjectDirectory: (directory: string) => void;
  onToggleSnippets: () => void;
  onOpenAttentionCenter: () => void;
}

export function StatusBar({
  project,
  git,
  terminal,
  attentionCount,
  snippetsOpen,
  snippetsDisabled,
  onOpenProjectDirectory,
  onToggleSnippets,
  onOpenAttentionCenter,
}: Props) {
  const waiting = terminal?.status === "waiting";
  const externalStatus = terminal?.externalStatus;
  const dirtyRef = useRef<HTMLDivElement>(null);
  const [showDirtyFiles, setShowDirtyFiles] = useState(false);
  const [dirtyFiles, setDirtyFiles] = useState<GitChangedFile[]>([]);
  const [dirtyFilesLoading, setDirtyFilesLoading] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [diffText, setDiffText] = useState("");
  const [diffLoading, setDiffLoading] = useState(false);
  const [diffQuery, setDiffQuery] = useState("");

  useEffect(() => {
    if (!showDirtyFiles) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!dirtyRef.current?.contains(event.target as Node)) {
        setShowDirtyFiles(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [showDirtyFiles]);

  useEffect(() => {
    setShowDirtyFiles(false);
    setDirtyFiles([]);
    setShowDiff(false);
    setDiffText("");
    setDiffQuery("");
  }, [project?.directory]);

  const toggleDirtyFiles = () => {
    if (!project) return;
    setShowDirtyFiles((open) => !open);
    setDirtyFilesLoading(true);
    void window.aya.getGitChangedFiles(project.directory).then((files) => {
      setDirtyFiles(files);
      setDirtyFilesLoading(false);
    });
  };

  const openDiff = () => {
    if (!project) return;
    setShowDiff(true);
    setDiffLoading(true);
    void window.aya.getGitDiff(project.directory).then((diff) => {
      setDiffText(diff);
      setDiffLoading(false);
    });
  };

  return (
    <footer className="aya-statusbar">
      {project && (
        <button
          className="aya-statusbar-item aya-statusbar-button"
          type="button"
          title="Open project directory"
          onClick={() => onOpenProjectDirectory(project.directory)}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            folder
          </span>
          {project.directory}
        </button>
      )}
      {terminal && waiting && (
        <span className="aya-statusbar-item aya-statusbar-item--warn">
          <span
            style={{
              fontFamily: "Material Symbols Outlined",
              fontSize: ICON_SIZE_SM_PX,
              fontVariationSettings: '"FILL" 1',
            }}
          >
            notifications_active
          </span>
          {terminal.name} is waiting for your approval
        </span>
      )}
      {externalStatus && !waiting && (
        <span
          className={`aya-statusbar-item aya-statusbar-item--agent aya-statusbar-item--agent-${externalStatus.level}`}
          title={new Date(externalStatus.updatedAt).toLocaleString()}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            smart_toy
          </span>
          {externalStatus.text}
        </span>
      )}
      <div className="aya-statusbar-spacer" />
      <button
        data-testid="snippet-toggle"
        className={`aya-statusbar-item aya-statusbar-button aya-pane-snippettoggle aya-statusbar-snippet ${
          snippetsOpen ? "aya-pane-snippettoggle--on" : ""
        }`}
        type="button"
        title={
          snippetsDisabled
            ? "Saved snippets (open a terminal first)"
            : "Saved snippets"
        }
        onMouseDown={(e) => e.preventDefault()}
        onClick={onToggleSnippets}
        disabled={snippetsDisabled}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          bolt
        </span>
        snippets
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          {snippetsOpen ? "expand_more" : "expand_less"}
        </span>
      </button>
      <button
        className={`aya-statusbar-item aya-statusbar-button ${
          attentionCount > 0 ? "aya-statusbar-item--warn" : ""
        }`}
        type="button"
        title="Open attention center"
        onClick={onOpenAttentionCenter}
      >
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
          notifications_active
        </span>
        {attentionCount > 0 ? `${attentionCount} attention` : "activity"}
      </button>
      {git?.branch && (
        <span className="aya-statusbar-item">
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            fork_right
          </span>
          {git.branch}
        </span>
      )}
      {git && git.dirty > 0 ? (
        <div className="aya-statusbar-popover-host" ref={dirtyRef}>
          <button
            className="aya-statusbar-item aya-statusbar-button aya-statusbar-item--warn"
            type="button"
            title="Show changed files"
            // Inline dropdown — keep terminal focus (same as the top-bar ones).
            onMouseDown={(e) => e.preventDefault()}
            onClick={toggleDirtyFiles}
          >
            <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
              edit_note
            </span>
            {git.dirty} dirty
          </button>
          {showDirtyFiles && (
            <div
              className={`aya-statusbar-popover ${showDiff ? "aya-statusbar-popover--diff" : ""}`}
              role="dialog"
              aria-label={showDiff ? "Git diff" : "Changed files"}
            >
              <div className="aya-statusbar-popover-title">
                {showDiff ? (
                  <>
                    <button
                      className="aya-statusbar-popover-back"
                      type="button"
                      title="Back to changed files"
                      onClick={() => setShowDiff(false)}
                    >
                      <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 15 }}>
                        arrow_back
                      </span>
                    </button>
                    Diff
                  </>
                ) : (
                  <>
                    <span>Changed files</span>
                    <button
                      className="aya-statusbar-popover-action"
                      type="button"
                      onClick={openDiff}
                    >
                      Show diff
                    </button>
                  </>
                )}
              </div>
              {showDiff ? (
                <DiffPanel
                  diff={diffText}
                  loading={diffLoading}
                  query={diffQuery}
                  onQueryChange={setDiffQuery}
                />
              ) : dirtyFilesLoading ? (
                <div className="aya-statusbar-popover-empty">Loading...</div>
              ) : dirtyFiles.length === 0 ? (
                <div className="aya-statusbar-popover-empty">No changed files.</div>
              ) : (
                <div className="aya-dirty-file-list">
                  {dirtyFiles.map((file) => (
                    <div
                      className="aya-dirty-file-row"
                      key={`${file.status}-${file.path}`}
                      title={file.path}
                    >
                      <span className="aya-dirty-file-status">{file.status}</span>
                      <span className="aya-dirty-file-path">{file.path}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      ) : git?.branch ? (
        <span
          className="aya-statusbar-item"
          style={{ color: "var(--status-active)" }}
        >
          <span style={{ fontFamily: "Material Symbols Outlined", fontSize: ICON_SIZE_SM_PX }}>
            check_circle
          </span>
          clean
        </span>
      ) : null}
    </footer>
  );
}

interface DiffLine {
  text: string;
  kind: "file" | "hunk" | "add" | "del" | "ctx" | "meta";
  language: string;
}

function languageForPath(filePath: string): string {
  const lower = filePath.toLowerCase();
  const ext = lower.split(".").pop() ?? "";
  const byExtension: Record<string, string> = {
    bash: "bash",
    c: "c",
    cc: "cpp",
    cjs: "javascript",
    cpp: "cpp",
    cs: "csharp",
    css: "css",
    diff: "diff",
    dockerfile: "dockerfile",
    go: "go",
    h: "cpp",
    hpp: "cpp",
    htm: "xml",
    html: "xml",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "javascript",
    kt: "kotlin",
    kts: "kotlin",
    lua: "lua",
    md: "markdown",
    mjs: "javascript",
    patch: "diff",
    php: "php",
    pl: "perl",
    plist: "xml",
    pm: "perl",
    py: "python",
    rb: "ruby",
    rs: "rust",
    sass: "scss",
    scss: "scss",
    sh: "bash",
    sql: "sql",
    svg: "xml",
    swift: "swift",
    toml: "ini",
    ts: "typescript",
    tsx: "typescript",
    txt: "plaintext",
    xml: "xml",
    yaml: "yaml",
    yml: "yaml",
    zsh: "bash",
  };
  if (lower.endsWith("dockerfile") || lower.endsWith(".dockerfile")) return "dockerfile";
  if (lower.endsWith("makefile")) return "makefile";
  return byExtension[ext] ?? "plaintext";
}

function annotateDiff(diff: string): DiffLine[] {
  let language = "text";
  return diff.split("\n").map((text) => {
    if (text.startsWith("+++ b/")) language = languageForPath(text.slice(6));
    if (text.startsWith("diff --git")) return { text, kind: "file", language };
    if (text.startsWith("@@")) return { text, kind: "hunk", language };
    if (text.startsWith("+") && !text.startsWith("+++")) return { text, kind: "add", language };
    if (text.startsWith("-") && !text.startsWith("---")) return { text, kind: "del", language };
    if (text.startsWith(" ")) return { text, kind: "ctx", language };
    return { text, kind: "meta", language };
  });
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function highlightCodeHtml(code: string, language: string): string {
  if (!hljs.getLanguage(language)) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

function markHtmlOccurrences(html: string, query: string): string {
  const q = query.trim();
  if (!q) return html;
  let out = "";
  let inTag = false;
  let textBuffer = "";
  const flushText = () => {
    if (!textBuffer) return;
    const escapedQuery = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out += textBuffer.replace(
      new RegExp(escapedQuery, "gi"),
      (match) => `<mark>${match}</mark>`,
    );
    textBuffer = "";
  };
  for (const ch of html) {
    if (ch === "<") {
      flushText();
      inTag = true;
      out += ch;
    } else if (ch === ">") {
      inTag = false;
      out += ch;
    } else if (inTag) {
      out += ch;
    } else {
      textBuffer += ch;
    }
  }
  flushText();
  return out;
}

function DiffPanel({
  diff,
  loading,
  query,
  onQueryChange,
}: {
  diff: string;
  loading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
}) {
  const lines = useMemo(() => annotateDiff(diff), [diff]);
  const matchCount = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return 0;
    return diff.toLowerCase().split(q).length - 1;
  }, [diff, query]);
  return (
    <div className="aya-diff-panel">
      <div className="aya-diff-search">
        <span style={{ fontFamily: "Material Symbols Outlined", fontSize: 14 }}>search</span>
        <input
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search diff"
          spellCheck={false}
        />
        {query.trim() ? <span>{matchCount} matches</span> : null}
      </div>
      {loading ? (
        <div className="aya-statusbar-popover-empty">Loading diff...</div>
      ) : !diff ? (
        <div className="aya-statusbar-popover-empty">No diff available.</div>
      ) : (
        <div className="aya-diff-view">
          {lines.map((line, index) => {
            const prefix = ["add", "del", "ctx"].includes(line.kind) ? line.text.slice(0, 1) : "";
            const code = prefix ? line.text.slice(1) : line.text;
            const highlighted = markHtmlOccurrences(
              highlightCodeHtml(code, line.language),
              query,
            );
            return (
              <div className={`aya-diff-view-line aya-diff-view-line--${line.kind}`} key={index}>
                <span className="aya-diff-view-gutter">{index + 1}</span>
                <span className="aya-diff-view-code">
                  {prefix ? <span className="aya-diff-prefix">{prefix}</span> : null}
                  <span dangerouslySetInnerHTML={{ __html: highlighted }} />
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
