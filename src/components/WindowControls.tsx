// Custom window chrome shared by both layouts' top bars. macOS draws its own
// traffic lights at the leading edge; Linux draws min/maximize/close at the
// trailing edge. Each component renders nothing off its platform, so callers
// can drop both in unconditionally.

interface MacProps {
  platform: NodeJS.Platform;
  isFullScreen: boolean;
  onClose: () => void;
  onMinimize: () => void;
  onToggleFullScreen: () => void;
}

export function MacWindowControls({
  platform,
  isFullScreen,
  onClose,
  onMinimize,
  onToggleFullScreen,
}: MacProps) {
  if (platform !== "darwin") return null;
  return (
    <div className="aya-mac-window-controls" aria-label="Window controls">
      <button
        className="aya-mac-window-control aya-mac-window-control--close"
        title="Close"
        aria-label="Close"
        onClick={onClose}
      >
        <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3.25 3.25L8.75 8.75M8.75 3.25L3.25 8.75" />
        </svg>
      </button>
      <button
        className="aya-mac-window-control aya-mac-window-control--minimize"
        title="Minimize"
        aria-label="Minimize"
        onClick={onMinimize}
      >
        <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          <path d="M3 6H9" />
        </svg>
      </button>
      <button
        className="aya-mac-window-control aya-mac-window-control--fullscreen"
        title={isFullScreen ? "Exit full screen" : "Full screen"}
        aria-label={isFullScreen ? "Exit full screen" : "Full screen"}
        onClick={onToggleFullScreen}
      >
        <svg className="aya-mac-window-control-icon" viewBox="0 0 12 12" aria-hidden="true">
          {isFullScreen ? (
            <>
              <path d="M4.5 2.75V4.5H2.75" />
              <path d="M7.5 9.25V7.5H9.25" />
            </>
          ) : (
            <>
              <path d="M7.5 2.75H9.25V4.5" />
              <path d="M4.5 9.25H2.75V7.5" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

interface LinuxProps {
  platform: NodeJS.Platform;
  isMaximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

export function LinuxWindowControls({
  platform,
  isMaximized,
  onMinimize,
  onToggleMaximize,
  onClose,
}: LinuxProps) {
  if (platform !== "linux") return null;
  return (
    <div className="aya-window-controls" aria-label="Window controls">
      <button
        className="aya-window-control"
        title="Minimize"
        aria-label="Minimize"
        onClick={onMinimize}
      >
        <span style={{ fontFamily: "Material Symbols Outlined" }}>remove</span>
      </button>
      <button
        className="aya-window-control"
        title={isMaximized ? "Restore" : "Maximize"}
        aria-label={isMaximized ? "Restore" : "Maximize"}
        onClick={onToggleMaximize}
      >
        <span style={{ fontFamily: "Material Symbols Outlined" }}>
          {isMaximized ? "filter_none" : "crop_square"}
        </span>
      </button>
      <button
        className="aya-window-control aya-window-control--close"
        title="Close"
        aria-label="Close"
        onClick={onClose}
      >
        <span style={{ fontFamily: "Material Symbols Outlined" }}>close</span>
      </button>
    </div>
  );
}
