import {
  memo,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  TerminalState
} from "../types";


export const markdownPlugins = [remarkGfm];


export function cleanIpcError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
}


export function isSafeExternalHref(href: string | undefined): href is string {
  if (!href) return false;
  try {
    const parsed = new URL(href);
    return (
      parsed.protocol === "http:" ||
      parsed.protocol === "https:" ||
      parsed.protocol === "mailto:"
    );
  } catch {
    return false;
  }
}


export function toggleMarkdownTaskItem(
  markdown: string,
  targetIndex: number,
): string {
  let idx = 0;
  return markdown.replace(
    /^(\s*(?:[-*+]|\d+\.)\s+\[)([ xX])(\]\s.*)$/gm,
    (full, prefix: string, state: string, suffix: string) => {
      const current = idx;
      idx += 1;
      if (current !== targetIndex) return full;
      const nextState = state === " " ? "x" : " ";
      return `${prefix}${nextState}${suffix}`;
    },
  );
}


export function extractChecklistProgress(
  markdown: string | undefined,
): { completed: number; total: number } | null {
  if (!markdown) return null;
  let completed = 0;
  let total = 0;
  const re = /^\s*(?:[-*+]|\d+\.)\s+\[([ xX])\]\s/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(markdown)) !== null) {
    total += 1;
    if (match[1].toLowerCase() === "x") {
      completed += 1;
    }
  }
  return total > 0 ? { completed, total } : null;
}


export function parseLabelsInput(raw: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    result.push(trimmed);
  }
  return result;
}


export function toggleLabelInDraft(draft: string, label: string): string {
  const current = parseLabelsInput(draft);
  const lower = label.toLowerCase();
  const exists = current.some((l) => l.toLowerCase() === lower);
  const next = exists
    ? current.filter((l) => l.toLowerCase() !== lower)
    : [...current, label];
  return next.join(", ");
}


export function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Could not read image file."));
    reader.readAsDataURL(file);
  });
}


export function livePaneDotInfo(pane: TerminalState | undefined): {
  modifier: string;
  label: string;
} {
  if (!pane) {
    return { modifier: "closed", label: "Terminal closed" };
  }
  const extLevel = pane.externalStatus?.level;
  const extText = pane.externalStatus?.text;
  if (extLevel === "waiting" || pane.bell) {
    return {
      modifier: "waiting",
      label: extText || "Waiting for user input",
    };
  }
  if (extLevel === "error" || pane.status === "error") {
    return { modifier: "error", label: extText || "Error" };
  }
  if (extLevel === "done") {
    return { modifier: "done", label: extText || "Finished turn" };
  }
  if (extLevel === "active" || pane.status === "running") {
    return { modifier: "working", label: extText || "Running" };
  }
  return { modifier: "idle", label: extText || "Idle" };
}


export const KanbanBoardImage = memo(function KanbanBoardImage({
  projectSlug,
  src,
  alt,
  onPreview,
}: {
  projectSlug: string;
  src: string;
  alt: string;
  onPreview: (img: { src: string; alt: string }) => void;
}) {
  const isDirectUrl =
    /^https?:\/\//i.test(src) || /^data:image\//i.test(src);
  const [resolvedSrc, setResolvedSrc] = useState<string>(
    isDirectUrl ? src : "",
  );
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (isDirectUrl) {
      setResolvedSrc(src);
      setFailed(false);
      return;
    }
    let active = true;
    setFailed(false);
    if (typeof window.aya?.readBoardImage === "function") {
      void window.aya
        .readBoardImage({ projectSlug, src })
        .then((dataUrl) => {
          if (active) setResolvedSrc(dataUrl);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
    } else {
      setFailed(true);
    }
    return () => {
      active = false;
    };
  }, [isDirectUrl, projectSlug, src]);

  if (failed) {
    return (
      <span className="aya-kanban-md-img-missing" title={src}>
        🖼 {alt || src}
      </span>
    );
  }
  if (!resolvedSrc) {
    return <span className="aya-kanban-md-img-loading">Loading image…</span>;
  }
  return (
    <img
      src={resolvedSrc}
      alt={alt}
      className="aya-kanban-md-img"
      draggable={false}
      loading="lazy"
      title="Click to enlarge image"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onPreview({ src: resolvedSrc, alt: alt || "Image" });
      }}
      onError={() => setFailed(true)}
    />
  );
});


export const KanbanCardMarkdown = memo(function KanbanCardMarkdown({
  projectSlug,
  text,
  onToggleTask,
  onPreviewImage,
}: {
  projectSlug: string;
  text: string;
  onToggleTask?: (checkboxIndex: number) => void;
  onPreviewImage: (img: { src: string; alt: string }) => void;
}) {
  const checkboxCounterRef = useRef(0);
  checkboxCounterRef.current = 0;

  const components = useMemo(
    () => ({
      a: ({
        href,
        children,
      }: {
        href?: string;
        children?: React.ReactNode;
      }) =>
        isSafeExternalHref(href) ? (
          <a
            href={href}
            className="aya-kanban-md-link"
            draggable={false}
            title={`Open ${href}`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void window.aya.openUrl(href);
            }}
          >
            <span>{children}</span>
            <span className="aya-kanban-md-link-arrow" aria-hidden="true">
              ↗
            </span>
          </a>
        ) : (
          <span>{children}</span>
        ),
      img: ({ src, alt }: { src?: string; alt?: string }) => (
        <KanbanBoardImage
          projectSlug={projectSlug}
          src={String(src || "")}
          alt={alt || "Image"}
          onPreview={onPreviewImage}
        />
      ),
      input: ({
        type,
        checked,
      }: {
        type?: string;
        checked?: boolean;
      }) => {
        if (type !== "checkbox") return <input type={type} readOnly />;
        const idx = checkboxCounterRef.current;
        checkboxCounterRef.current += 1;
        return (
          <input
            type="checkbox"
            className="aya-kanban-md-checkbox"
            checked={Boolean(checked)}
            onChange={(e) => {
              e.stopPropagation();
              onToggleTask?.(idx);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        );
      },
    }),
    [onPreviewImage, onToggleTask, projectSlug],
  );

  return (
    <div
      className="aya-kanban-md"
      onDoubleClick={(e) => {
        const target = e.target as HTMLElement | null;
        if (target?.closest("a, img, input, button")) {
          e.stopPropagation();
        }
      }}
    >
      <ReactMarkdown remarkPlugins={markdownPlugins} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});
