import { HOOK_THROTTLE_MINUTES } from "../../main-mirrors";
import { closeFromBackdropClick, markBackdropMouseDown } from "../modal-backdrop";

interface ConsentDialogProps {
  onClose: () => void;
  onConfirm: () => void;
}

export function UsageConsentDialog({ onClose, onConfirm }: ConsentDialogProps) {
  return (
    <div
      className="aya-modal-backdrop"
      style={{ zIndex: 10 }}
      onMouseDown={(e) => {
        e.stopPropagation();
        markBackdropMouseDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        closeFromBackdropClick(
          e,
          onClose,
        );
      }}
    >
      <div
        className="aya-modal aya-settings-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enable the usage chip?"
        tabIndex={-1}
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Enable the usage chip?</div>
        <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
          This writes a small script and a <code>Stop</code> hook into{" "}
          <code>~/.claude/settings.json</code>. After each Claude Code
          response (throttled to every {HOOK_THROTTLE_MINUTES}&nbsp;min) the hook queries
          Anthropic&apos;s <strong>undocumented</strong> usage endpoint with
          your own token and saves the result locally for the chip.
          <br />
          <br />
          It is <strong>unsupported</strong> and may change without notice.
          Aya itself never reads your token and never makes the call — that
          happens only in the hook, run by Claude Code. Nothing is sent
          anywhere else. You can turn it off here anytime (it removes both).
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button
            className="aya-modal-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={onConfirm}
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}

export function StatusConsentDialog({ onClose, onConfirm }: ConsentDialogProps) {
  return (
    <div
      className="aya-modal-backdrop"
      style={{ zIndex: 10 }}
      onMouseDown={(e) => {
        e.stopPropagation();
        markBackdropMouseDown(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        closeFromBackdropClick(
          e,
          onClose,
        );
      }}
    >
      <div
        className="aya-modal aya-settings-consent-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Enable automatic status?"
        tabIndex={-1}
        style={{ maxWidth: 460 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="aya-modal-title">Enable automatic status?</div>
        <div className="aya-modal-hint" style={{ lineHeight: 1.6 }}>
          This writes a small script and Claude Code{" "}
          <code>Notification</code>, <code>PostToolUse</code> and{" "}
          <code>Stop</code> hooks into{" "}
          <code>~/.claude/settings.json</code>. Claude then reports its own
          turn state into the Aya pane it runs in: waiting for your input,
          running a tool, or done.
          <br />
          <br />
          For Codex it sets a <code>notify</code> program in{" "}
          <code>~/.codex/config.toml</code> so a finished turn shows{" "}
          <em>done</em>. If you already have your own Codex{" "}
          <code>notify</code>, Aya leaves it untouched.
          <br />
          <br />
          The hooks fire in every Claude Code / Codex session, but the
          script does nothing outside an Aya terminal. Aya sends nothing
          anywhere; it only sets the pane&apos;s status locally. You can
          turn it off here anytime (it removes both).
        </div>
        <div
          style={{
            display: "flex",
            gap: 8,
            justifyContent: "flex-end",
            marginTop: 16,
          }}
        >
          <button
            className="aya-modal-btn"
            onClick={onClose}
          >
            Cancel
          </button>
          <button
            className="aya-modal-btn aya-modal-btn--primary"
            onClick={onConfirm}
          >
            Enable
          </button>
        </div>
      </div>
    </div>
  );
}
