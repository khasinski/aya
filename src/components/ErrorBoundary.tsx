import { Component, type ErrorInfo, type ReactNode } from "react";
import { errorDetails } from "../error-details";

interface State {
  failed: boolean;
  error: unknown;
  componentStack: string | null;
}

/** Catches a render error anywhere in the window. Without it React unmounts the whole tree and
 *  leaves a blank window. The terminals and agents keep running in the pty host, so a reload
 *  gets the user back to them. */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { failed: false, error: null, componentStack: null };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { failed: true, error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.setState({ componentStack: info.componentStack ?? null });
    console.error("Aya window error:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="aya-crash" role="alert">
        <div className="aya-modal-title">This window hit an error</div>
        <p className="aya-crash-text">Your terminals and agents keep running. Reload the window to get back to them.</p>
        <button className="aya-modal-btn aya-modal-btn--primary" onClick={() => void window.aya.reloadWindow()}>
          Reload window
        </button>
        <pre className="aya-crash-details">{errorDetails(this.state.error, this.state.componentStack)}</pre>
      </div>
    );
  }
}
