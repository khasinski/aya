import { useEffect, useState } from "react";
import { type WebConfigureRequest, type WebServerStatus } from "../../types";
import { allNetworksWarning, WEB_LOOPBACK_HOST, webHostOptions } from "../../web-host-options";
import { SettingsRow } from "./parts";

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The Aya Web row: it owns the server status and its port/user/password drafts, nothing else in the modal reads them. */
export function AyaWebRow({ isWeb }: { isWeb: boolean }) {
  const [ayaWeb, setAyaWeb] = useState<WebServerStatus | null>(null);
  const [ayaWebBusy, setAyaWebBusy] = useState(false);
  const [ayaWebError, setAyaWebError] = useState<string | null>(null);
  const [ayaWebPortDraft, setAyaWebPortDraft] = useState("");
  const [ayaWebUserDraft, setAyaWebUserDraft] = useState("");
  const [ayaWebPasswordDraft, setAyaWebPasswordDraft] = useState("");

  useEffect(() => {
    let cancelled = false;
    void window.aya
      .webStatus()
      .then((status) => {
        if (cancelled) return;
        setAyaWeb(status);
        setAyaWebPortDraft(String(status.port));
        setAyaWebUserDraft(status.user);
      })
      // A web.json Aya cannot read now (permissions) is reported, not replaced: say why the controls stay off.
      .catch((err: unknown) => {
        if (!cancelled) setAyaWebError(messageOf(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const applyAyaWeb = async (req: WebConfigureRequest) => {
    setAyaWebBusy(true);
    setAyaWebError(null);
    try {
      const status = await window.aya.configureWeb(req);
      setAyaWeb(status);
      setAyaWebPortDraft(String(status.port));
      setAyaWebUserDraft(status.user);
      setAyaWebPasswordDraft("");
    } catch (err) {
      setAyaWebError(messageOf(err));
    } finally {
      setAyaWebBusy(false);
    }
  };

  const regenerateAyaWebPassword = async () => {
    setAyaWebBusy(true);
    setAyaWebError(null);
    try {
      setAyaWeb(await window.aya.regenerateWebPassword());
    } catch (err) {
      setAyaWebError(messageOf(err));
    } finally {
      setAyaWebBusy(false);
    }
  };

  return (
    <SettingsRow
    icon="captive_portal"
    title={
    <>
      Aya Web{" "}
      <span className="aya-settings-experimental">Experimental</span>
    </>
    }
    control={isWeb ? (
    <span className="aya-modal-hint">Available in the desktop app.</span>
    ) : (
    <div className="aya-settings-segmented" aria-label="Aya Web">
      {([
        [true, "On"],
        [false, "Off"],
      ] as const).map(([enabled, label]) => (
        <button
          key={String(enabled)}
          type="button"
          className={`aya-settings-segment ${
            (ayaWeb?.enabled ?? false) === enabled
              ? "aya-settings-segment--active"
              : ""
          }`}
          disabled={ayaWebBusy || !ayaWeb}
          onClick={() => void applyAyaWeb({ enabled })}
        >
          {label}
        </button>
      ))}
    </div>
    )}
    >
    {isWeb ? (
    "Aya Web server settings can only be changed from the desktop app."
    ) : (
    <>Use Aya from a browser, behind a user and password. Signing in
      gives full shell access to this machine. A new setup listens on
      this computer only: from another one, use an SSH tunnel, or choose
      a network below. There is no TLS, so on a network the password and
      your terminals travel unencrypted; choose only one you trust
      (Tailscale, WireGuard or your own LAN).</>
    )}
    {(ayaWebError ?? ayaWeb?.error) && (
    <div style={{ color: "#f85149", marginTop: 6 }}>
      {ayaWebError ?? ayaWeb?.error}
    </div>
    )}
    {ayaWeb && !isWeb && (
    <label
      style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", marginTop: 8 }}
    >
      Listen on
      <select
        className="aya-modal-input"
        aria-label="Aya Web listen address"
        value={ayaWeb.host}
        disabled={ayaWebBusy}
        onChange={(e) => void applyAyaWeb({ host: e.target.value })}
      >
        {webHostOptions(ayaWeb).map(([host, label]) => (
          <option key={host} value={host}>
            {label}
          </option>
        ))}
      </select>
    </label>
    )}
    {/* role=status: read out when it appears after a change, not on every open of Settings. */}
    {ayaWeb && !isWeb && allNetworksWarning(ayaWeb) && (
    <div role="status" style={{ marginTop: 6 }}>
      <strong>Warning:</strong> {allNetworksWarning(ayaWeb)}{" "}
      <button
        className="aya-modal-btn"
        type="button"
        disabled={ayaWebBusy}
        onClick={() => void applyAyaWeb({ host: WEB_LOOPBACK_HOST })}
      >
        This computer only
      </button>
    </div>
    )}
    {isWeb ? (
    <div className="aya-modal-hint" role="status">
      Aya Web server settings are available in the desktop app.
    </div>
    ) : ayaWeb?.enabled && (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 6,
        marginTop: 8,
      }}
    >
      <div>
        {ayaWeb.running ? (
          <>
            Running at{" "}
            {ayaWeb.urls.map((url, i) => (
              <span key={url}>
                {i > 0 && ", "}
                <a
                  href={url}
                  onClick={(e) => {
                    e.preventDefault();
                    void window.aya.openUrl(url);
                  }}
                >
                  {url}
                </a>
              </span>
            ))}
            {" — "}
            {ayaWeb.clients} client{ayaWeb.clients === 1 ? "" : "s"}{" "}
            connected.
          </>
        ) : (
          "Enabled but not running."
        )}
      </div>
      <div>
        Sign in as <code>{ayaWeb.user}</code> with{" "}
        {ayaWeb.generatedPassword ? (
          <>
            password <code>{ayaWeb.generatedPassword}</code>
          </>
        ) : (
          "your custom password"
        )}
        {"  "}
        <button
          className="aya-modal-btn"
          type="button"
          disabled={ayaWebBusy}
          onClick={() => void regenerateAyaWebPassword()}
          style={{ marginLeft: 8 }}
        >
          Regenerate password
        </button>
      </div>
      <div
        style={{
          display: "flex",
          gap: 6,
          alignItems: "center",
          flexWrap: "wrap",
        }}
      >
        <input
          className="aya-modal-input"
          style={{ width: 70 }}
          aria-label="Aya Web port"
          value={ayaWebPortDraft}
          onChange={(e) => setAyaWebPortDraft(e.target.value)}
          placeholder="Port"
        />
        <input
          className="aya-modal-input"
          style={{ width: 120 }}
          aria-label="Aya Web user"
          value={ayaWebUserDraft}
          onChange={(e) => setAyaWebUserDraft(e.target.value)}
          placeholder="User"
        />
        <input
          className="aya-modal-input"
          style={{ width: 160 }}
          aria-label="Aya Web custom password"
          type="password"
          value={ayaWebPasswordDraft}
          onChange={(e) => setAyaWebPasswordDraft(e.target.value)}
          placeholder="New password (optional)"
        />
        <button
          className="aya-modal-btn"
          type="button"
          disabled={ayaWebBusy}
          onClick={() =>
            void applyAyaWeb({
              port: Number(ayaWebPortDraft),
              user: ayaWebUserDraft,
              ...(ayaWebPasswordDraft
                ? { password: ayaWebPasswordDraft }
                : {}),
            })
          }
        >
          Apply
        </button>
      </div>
    </div>
    )}
    </SettingsRow>
  );
}
