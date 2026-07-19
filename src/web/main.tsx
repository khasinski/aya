// Aya Web (experimental) — browser entry point.
//
// Boot order matters: window.aya must exist before App's module tree runs,
// so the App component is imported dynamically only after the WebSocket
// bridge is connected and installed.

import "@xterm/xterm/css/xterm.css";
import "../styles/armillary.css";
import "../styles/app.css";
import "../styles/overrides.css";

import {
  useEffect,
  useState,
  type ComponentType,
  type FormEvent,
} from "react";
import { createRoot } from "react-dom/client";
import { createWebAya } from "./bridge";
import { connectWebTransport, webSocketUrl } from "./transport";

const container = document.getElementById("root");
if (!container) throw new Error("#root not found");
const root = createRoot(container);

const screenStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  height: "100vh",
  background: "#0d1117",
  color: "#e6edf3",
  fontFamily:
    "'Source Sans 3', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
};

const cardStyle: React.CSSProperties = {
  width: 320,
  padding: "32px 28px",
  borderRadius: 12,
  background: "#161b22",
  border: "1px solid #30363d",
  display: "flex",
  flexDirection: "column",
  gap: 12,
};

const inputStyle: React.CSSProperties = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #30363d",
  background: "#0d1117",
  color: "#e6edf3",
  fontSize: 14,
};

const buttonStyle: React.CSSProperties = {
  padding: "9px 10px",
  borderRadius: 6,
  border: "none",
  background: "#238636",
  color: "#fff",
  fontSize: 14,
  fontWeight: 600,
  cursor: "pointer",
};

function CenteredMessage({ text }: { text: string }) {
  return (
    <div style={screenStyle}>
      <div style={{ opacity: 0.8 }}>{text}</div>
    </div>
  );
}

function LoginScreen({
  onLoggedIn,
}: {
  onLoggedIn: () => void;
}) {
  const [user, setUser] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user, password }),
      });
      if (res.ok) {
        onLoggedIn();
        return;
      }
      setError(
        res.status === 429
          ? "Too many attempts — try again in a few minutes."
          : "Wrong user or password.",
      );
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={screenStyle}>
      <form style={cardStyle} onSubmit={submit}>
        <div style={{ fontSize: 20, fontWeight: 700, marginBottom: 4 }}>
          Aya Web
        </div>
        <div style={{ fontSize: 13, opacity: 0.7, marginBottom: 8 }}>
          Sign in with the credentials from Aya's Settings on the host
          machine.
        </div>
        <input
          style={inputStyle}
          placeholder="User"
          value={user}
          autoFocus
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUser(e.target.value)}
        />
        <input
          style={inputStyle}
          placeholder="Password"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error ? (
          <div style={{ color: "#f85149", fontSize: 13 }}>{error}</div>
        ) : null}
        <button style={buttonStyle} type="submit" disabled={busy}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

/** Fixed overlay + /api/me polling; reload restores the session (the cookie
 *  survives, terminals re-attach exactly like after a desktop restart). */
function showDisconnectedOverlay(): void {
  const overlay = document.createElement("div");
  overlay.style.cssText =
    "position:fixed;inset:0;z-index:99999;display:flex;align-items:center;" +
    "justify-content:center;background:rgba(13,17,23,0.85);color:#e6edf3;" +
    "font-size:15px;backdrop-filter:blur(2px)";
  overlay.textContent = "Connection to Aya lost — reconnecting…";
  document.body.appendChild(overlay);
  const timer = window.setInterval(async () => {
    try {
      const res = await fetch("/api/me");
      if (res.ok) {
        window.clearInterval(timer);
        window.location.reload();
      }
    } catch {
      // Host still unreachable — keep polling.
    }
  }, 2000);
}

function WebBoot({ authenticated }: { authenticated: boolean }) {
  const [phase, setPhase] = useState<"login" | "connecting" | "error">(
    authenticated ? "connecting" : "login",
  );
  const [error, setError] = useState<string | null>(null);
  const [AppComponent, setAppComponent] = useState<ComponentType | null>(
    null,
  );

  useEffect(() => {
    if (phase !== "connecting" || AppComponent) return;
    let cancelled = false;
    void (async () => {
      try {
        const transport = await connectWebTransport(webSocketUrl());
        if (cancelled) return;
        window.aya = createWebAya(transport);
        transport.onClose(showDisconnectedOverlay);
        const mod = await import("../App");
        if (cancelled) return;
        setAppComponent(() => mod.App);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : String(err));
        setPhase("error");
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  if (AppComponent) return <AppComponent />;
  if (phase === "login") {
    return <LoginScreen onLoggedIn={() => setPhase("connecting")} />;
  }
  if (phase === "error") {
    return <CenteredMessage text={`Aya Web failed to start: ${error}`} />;
  }
  return <CenteredMessage text="Connecting to Aya…" />;
}

void (async () => {
  document.title = "Aya Web";
  let authenticated = false;
  try {
    authenticated = (await fetch("/api/me")).ok;
  } catch {
    authenticated = false;
  }
  root.render(<WebBoot authenticated={authenticated} />);
})();
