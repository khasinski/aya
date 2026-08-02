import { useEffect, useRef, useState } from "react";
import type {
  RemoteDirectoryListing,
  RemoteHealthResult,
  RemoteProjectCreateResult,
} from "../types";
import { closeFromBackdropClick, markBackdropMouseDown } from "./modal-backdrop";

interface Props {
  defaultDirectory?: string;
  lockDirectory?: boolean;
  title?: string;
  hint?: string;
  pathHint?: string;
  onPickDirectory?: () => Promise<string | null>;
  onCompletePath?: (pathPrefix: string) => Promise<string[]>;
  onDirectoryExists?: (directory: string) => Promise<boolean>;
  onCreateDirectory?: (directory: string) => Promise<void>;
  onListRemoteDirectory?: (
    sshTarget: string,
    directory?: string,
  ) => Promise<RemoteDirectoryListing>;
  onCreateRemoteProject?: (
    sshTarget: string,
    directory: string,
    name?: string,
  ) => Promise<RemoteProjectCreateResult>;
  onCreateRemoteDirectory?: (
    sshTarget: string,
    directory: string,
  ) => Promise<string>;
  onCheckRemoteHealth?: (sshTarget: string) => Promise<RemoteHealthResult>;
  onSubmitRemote?: (
    result: RemoteProjectCreateResult,
    sshTarget: string,
  ) => Promise<void> | void;
  onSubmit: (directory: string) => Promise<void> | void;
  onCancel: () => void;
}

type DirectoryStatus = "unknown" | "checking" | "exists" | "missing";
const DIRECTORY_CHECK_DEBOUNCE_MS = 500;

function basename(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "project";
}

function parentDir(p: string): string | null {
  const clean = p.replace(/\/+$/, "");
  if (!clean || clean === "/" || clean === "~") return null;
  if (clean.startsWith("~/") && !clean.slice(2).includes("/")) return "~";
  const idx = clean.lastIndexOf("/");
  if (idx <= 0) return clean.startsWith("/") ? "/" : null;
  return clean.slice(0, idx);
}

export function NewProjectModal({
  defaultDirectory = "~/",
  lockDirectory = false,
  title = "Open project",
  hint = "Type a project directory, or browse for one.",
  pathHint,
  onPickDirectory,
  onCompletePath,
  onDirectoryExists,
  onCreateDirectory,
  onListRemoteDirectory,
  onCreateRemoteProject,
  onCreateRemoteDirectory,
  onCheckRemoteHealth,
  onSubmitRemote,
  onSubmit,
  onCancel,
}: Props) {
  const canUseRemote =
    !lockDirectory &&
    !!onListRemoteDirectory &&
    !!onCreateRemoteProject &&
    !!onSubmitRemote;
  const [remoteVisible, setRemoteVisible] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState(false);
  const [directory, setDirectory] = useState(defaultDirectory || "~/");
  const [sshTarget, setSshTarget] = useState("");
  const [remotePath, setRemotePath] = useState("");
  const [remoteNewFolder, setRemoteNewFolder] = useState("");
  const [remoteListing, setRemoteListing] =
    useState<RemoteDirectoryListing | null>(null);
  const [remoteHealth, setRemoteHealth] = useState<RemoteHealthResult | null>(
    null,
  );
  const [remoteHealthLoading, setRemoteHealthLoading] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [directoryStatus, setDirectoryStatus] =
    useState<DirectoryStatus>("unknown");
  const directoryRef = useRef<HTMLInputElement>(null);
  const directoryCheckRef = useRef(0);
  const completionRef = useRef<{
    source: string;
    matches: string[];
    index: number;
    applied: string;
  } | null>(null);

  useEffect(() => {
    const input = directoryRef.current;
    input?.focus();
    input?.setSelectionRange(input.value.length, input.value.length);
  }, [remoteVisible]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const setDirectoryAndMaybeName = (next: string) => {
    setDirectory(next);
    setError(null);
    setDirectoryStatus("unknown");
    completionRef.current = null;
  };

  const setRemoteTarget = (next: string) => {
    setSshTarget(next);
    setRemoteListing(null);
    setRemoteHealth(null);
    setRemoteConnected(false);
    setRemotePath("");
    setError(null);
  };

  const checkRemote = async () => {
    if (!onCheckRemoteHealth || remoteHealthLoading || submitting) return;
    const target = sshTarget.trim();
    if (!target) {
      setError("Remote host is required.");
      return;
    }
    setRemoteHealthLoading(true);
    setError(null);
    try {
      setRemoteHealth(await onCheckRemoteHealth(target));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteHealthLoading(false);
    }
  };

  const listRemote = async (nextPath?: string) => {
    if (!onListRemoteDirectory || remoteLoading || submitting) return;
    const target = sshTarget.trim();
    if (!target) {
      setError("Remote host is required.");
      return;
    }
    setRemoteLoading(true);
    setError(null);
    try {
      const listing = await onListRemoteDirectory(
        target,
        (nextPath ?? remotePath.trim()) || undefined,
      );
      setRemoteListing(listing);
      setRemotePath(listing.path);
      setRemoteConnected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteLoading(false);
    }
  };

  const createRemoteFolder = async () => {
    if (
      !onCreateRemoteDirectory ||
      remoteLoading ||
      submitting ||
      !remoteListing
    ) {
      return;
    }
    const name = remoteNewFolder.trim();
    const target = sshTarget.trim();
    if (!name || !target) return;
    if (name.includes("/")) {
      setError("Folder name cannot contain '/'.");
      return;
    }
    const nextPath = `${remoteListing.path.replace(/\/+$/, "")}/${name}`;
    setRemoteLoading(true);
    setError(null);
    try {
      const createdPath = await onCreateRemoteDirectory(target, nextPath);
      setRemoteNewFolder("");
      await listRemote(createdPath);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRemoteLoading(false);
    }
  };

  const openRemoteProject = (directory: string) => {
    setRemotePath(directory);
    void listRemote(directory);
  };

  useEffect(() => {
    if (lockDirectory || !onDirectoryExists) return;
    const current = directory.trim();
    const token = directoryCheckRef.current + 1;
    directoryCheckRef.current = token;
    if (!current) {
      setDirectoryStatus("unknown");
      return;
    }
    const timer = window.setTimeout(() => {
      if (directoryCheckRef.current === token) {
        setDirectoryStatus("checking");
      }
      void onDirectoryExists(current)
        .then((exists) => {
          if (directoryCheckRef.current === token) {
            setDirectoryStatus(exists ? "exists" : "missing");
          }
        })
        .catch(() => {
          if (directoryCheckRef.current === token) {
            setDirectoryStatus("unknown");
          }
        });
    }, DIRECTORY_CHECK_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [directory, lockDirectory, onDirectoryExists]);

  const pickDirectory = async () => {
    if (!onPickDirectory || submitting) return;
    const picked = await onPickDirectory();
    if (!picked) return;
    setDirectoryAndMaybeName(picked);
  };

  const completeDirectory = async () => {
    if (!onCompletePath || submitting) return;
    const current = directory.trim() || "~/";
    const previous = completionRef.current;
    const isCycling = previous && previous.applied === current;
    const source = isCycling ? previous.source : current;
    const matches = isCycling
      ? previous.matches
      : await onCompletePath(source);
    if (matches.length === 0) {
      setError("No matching directories.");
      completionRef.current = null;
      return;
    }
    const index = isCycling ? (previous.index + 1) % matches.length : 0;
    const applied = matches[index];
    completionRef.current = { source, matches, index, applied };
    setDirectory(applied);
    setError(null);
  };

  const submit = async () => {
    if (submitting) return;
    if (remoteVisible) {
      if (!onCreateRemoteProject || !onSubmitRemote) return;
      const target = sshTarget.trim();
      const d = remotePath.trim();
      if (!target || !d) return;
      setSubmitting(true);
      setError(null);
      try {
        const result = await onCreateRemoteProject(target, d, basename(d));
        await onSubmitRemote(result, target);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSubmitting(false);
      }
      return;
    }
    const d = directory.trim();
    if (!d) return;
    setSubmitting(true);
    setError(null);
    try {
      let status = directoryStatus;
      if (onDirectoryExists) {
        const exists = await onDirectoryExists(d);
        status = exists ? "exists" : "missing";
        setDirectoryStatus(status);
      }
      if (status === "missing" && onCreateDirectory) {
        await onCreateDirectory(d);
      }
      await onSubmit(d);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="aya-modal-backdrop"
      onMouseDown={markBackdropMouseDown}
      onClick={
        submitting ? undefined : (e) => closeFromBackdropClick(e, onCancel)
      }
    >
      <div className="aya-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aya-modal-title">{title}</div>
        {hint && <div className="aya-modal-hint">{hint}</div>}
        {pathHint && (
          <div className="aya-modal-hint aya-modal-hint--path">{pathHint}</div>
        )}

        {!remoteVisible && !lockDirectory && (
          <>
            <label className="aya-modal-label">Directory</label>
            <div className="aya-modal-input-row">
              <input
                ref={directoryRef}
                className="aya-modal-input"
                value={directory}
                onChange={(e) => setDirectoryAndMaybeName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    submit();
                  } else if (e.key === "Tab") {
                    e.preventDefault();
                    void completeDirectory();
                  }
                }}
                placeholder="~/code/project"
                disabled={submitting}
                spellCheck={false}
              />
              {onPickDirectory && (
                <button
                  className="aya-modal-btn"
                  onClick={pickDirectory}
                  disabled={submitting}
                >
                  Browse
                </button>
              )}
              {canUseRemote && (
                <button
                  className="aya-modal-btn"
                  onClick={() => {
                    setRemoteVisible(true);
                    setError(null);
                  }}
                  disabled={submitting}
                >
                  Remote
                </button>
              )}
            </div>
          </>
        )}

        {remoteVisible && canUseRemote && (
          <div className="aya-remote-picker">
            <label className="aya-modal-label">Remote host</label>
            <div className="aya-modal-input-row">
              <input
                className="aya-modal-input"
                value={sshTarget}
                onChange={(e) => setRemoteTarget(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void listRemote();
                }}
                placeholder="user@host"
                disabled={submitting || remoteLoading}
                spellCheck={false}
              />
              {remoteConnected ? (
                <button
                  className="aya-modal-btn"
                  onClick={() => {
                    setRemoteVisible(false);
                    setRemoteConnected(false);
                    setRemoteListing(null);
                    setRemoteHealth(null);
                    setRemotePath("");
                    setError(null);
                  }}
                  disabled={submitting || remoteLoading}
                >
                  Disconnect
                </button>
              ) : (
                <button
                  className="aya-modal-btn"
                  onClick={() => void listRemote()}
                  disabled={submitting || remoteLoading || !sshTarget.trim()}
                >
                  {remoteLoading ? "Connecting..." : "Connect"}
                </button>
              )}
              {onCheckRemoteHealth && (
                <button
                  className="aya-modal-btn"
                  onClick={() => void checkRemote()}
                  disabled={
                    submitting ||
                    remoteLoading ||
                    remoteHealthLoading ||
                    !sshTarget.trim()
                  }
                >
                  {remoteHealthLoading ? "Checking..." : "Check"}
                </button>
              )}
            </div>
            <div className="aya-modal-hint aya-remote-help">
              Remote projects connect over SSH and require Aya to be installed
              and running on the other computer.
            </div>
            {remoteHealth && (
              <div
                className={`aya-remote-health ${
                  remoteHealth.ok ? "aya-remote-health--ok" : "aya-remote-health--error"
                }`}
              >
                <div className="aya-remote-health-title">
                  {remoteHealth.ok ? "Remote ready" : "Remote check failed"}
                </div>
                {remoteHealth.host && (
                  <div className="aya-remote-health-meta">
                    {remoteHealth.host.name} · {remoteHealth.presetsCount ?? 0} presets
                  </div>
                )}
                <div className="aya-remote-health-steps">
                  {remoteHealth.checks.map((check) => (
                    <div
                      key={check.stage}
                      className={`aya-remote-health-step ${
                        check.ok
                          ? "aya-remote-health-step--ok"
                          : "aya-remote-health-step--error"
                      }`}
                    >
                      <span>{check.stage}</span>
                      <p>{check.message}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {remoteListing && (
              <div className="aya-remote-browser">
                <div className="aya-remote-browser-header">
                  <span>{remoteListing.host.name}</span>
                  <code>{remoteListing.path}</code>
                </div>
                {remoteListing.recentProjects.length > 0 && (
                  <div className="aya-remote-recent">
                    <div className="aya-remote-section-title">
                      Recent projects on {remoteListing.host.name}
                    </div>
                    <div className="aya-remote-recent-list">
                      {remoteListing.recentProjects.slice(0, 6).map((project) => (
                        <button
                          key={project.slug}
                          className="aya-remote-project-row"
                          onClick={() => openRemoteProject(project.directory)}
                          disabled={submitting || remoteLoading}
                        >
                          <span className="aya-remote-project-name">
                            {project.name}
                          </span>
                          <code>{project.directory}</code>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div className="aya-remote-browser-list">
                  {parentDir(remoteListing.path) && (
                    <button
                      className="aya-remote-browser-row"
                      onClick={() =>
                        void listRemote(parentDir(remoteListing.path) ?? undefined)
                      }
                      disabled={submitting || remoteLoading}
                    >
                      <span className="aya-remote-browser-icon">..</span>
                      <span className="aya-remote-browser-name">
                        Parent directory
                      </span>
                    </button>
                  )}
                  {remoteListing.entries.length === 0 ? (
                    <div className="aya-remote-browser-empty">No directories</div>
                  ) : (
                    remoteListing.entries.map((entry) => (
                      <button
                        key={entry.path}
                        className="aya-remote-browser-row"
                        onClick={() => void listRemote(entry.path)}
                        disabled={submitting || remoteLoading}
                      >
                        <span className="aya-remote-browser-icon">dir</span>
                        <span className="aya-remote-browser-name">
                          {entry.name}
                        </span>
                      </button>
                    ))
                  )}
                </div>
                <div className="aya-remote-create">
                  <input
                    className="aya-modal-input"
                    value={remoteNewFolder}
                    onChange={(e) => {
                      setRemoteNewFolder(e.target.value);
                      setError(null);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void createRemoteFolder();
                    }}
                    placeholder="New folder"
                    disabled={submitting || remoteLoading}
                    spellCheck={false}
                  />
                  <button
                    className="aya-modal-btn"
                    onClick={() => void createRemoteFolder()}
                    disabled={
                      submitting || remoteLoading || !remoteNewFolder.trim()
                    }
                  >
                    Create
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {error && <div className="aya-modal-error">{error}</div>}
        <div className="aya-modal-actions">
          <button
            className="aya-modal-btn"
            onClick={onCancel}
            disabled={submitting}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={submit}
            disabled={
              submitting ||
              (remoteVisible
                ? !sshTarget.trim() || !remotePath.trim() || remoteLoading
                : !directory.trim() ||
                  directoryStatus === "checking" ||
                  (directoryStatus === "missing" && !onCreateDirectory))
            }
          >
            {remoteVisible
              ? submitting
                ? "Adding..."
                : "Open remote"
              : submitting
                ? directoryStatus === "missing"
                  ? "Creating..."
                  : "Opening..."
                : directoryStatus === "missing" && onCreateDirectory
                  ? "Create folder"
                  : "Open"}
          </button>
        </div>
      </div>
    </div>
  );
}
