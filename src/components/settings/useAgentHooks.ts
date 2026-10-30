import { useEffect, useState } from "react";
import { type StatusHookStatus, type UsageHookStatus } from "../../types";

/** The Claude Code usage and status hooks Settings can install. Enabling is called after the consent dialog. */
export function useAgentHooks() {
  const [usageHook, setUsageHook] = useState<UsageHookStatus | null>(null);
  const [usageHookBusy, setUsageHookBusy] = useState(false);
  const [statusHook, setStatusHook] = useState<StatusHookStatus | null>(null);
  const [statusHookBusy, setStatusHookBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void window.aya.usageHookStatus().then((status) => {
      if (!cancelled) setUsageHook(status);
    });
    void window.aya.statusHookStatus().then((status) => {
      if (!cancelled) setStatusHook(status);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Enabling writes a hook + script into ~/.claude (after the consent dialog);
  // disabling removes both. The Aya process itself never reads a token or hits
  // the endpoint — that only happens later in the script, run by Claude Code.
  const enableUsageHook = async () => {
    setUsageHookBusy(true);
    try {
      setUsageHook(await window.aya.installUsageHook());
    } finally {
      setUsageHookBusy(false);
    }
  };

  const disableUsageHook = async () => {
    setUsageHookBusy(true);
    try {
      setUsageHook(await window.aya.uninstallUsageHook());
    } finally {
      setUsageHookBusy(false);
    }
  };

  // Automatic status (#38): enabling writes Claude Code Notification/PostToolUse/
  // Stop hooks + a script into ~/.claude (after consent); disabling removes both.
  // The generated script only reports into the current Aya pane and no-ops in any
  // Claude session run outside Aya.
  const enableStatusHook = async () => {
    setStatusHookBusy(true);
    try {
      setStatusHook(await window.aya.installStatusHook());
    } finally {
      setStatusHookBusy(false);
    }
  };

  const disableStatusHook = async () => {
    setStatusHookBusy(true);
    try {
      setStatusHook(await window.aya.uninstallStatusHook());
    } finally {
      setStatusHookBusy(false);
    }
  };

  return { usageHook, usageHookBusy, enableUsageHook, disableUsageHook, statusHook, statusHookBusy, enableStatusHook, disableStatusHook };
}
