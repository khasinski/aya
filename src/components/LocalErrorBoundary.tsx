import { Component, type CSSProperties, type ErrorInfo, type ReactNode } from 'react';
import { errorDetails } from '../error-details';

/** Keep a failed surface from taking down neighbouring panes or its session. */
export class LocalErrorBoundary extends Component<{
  children: ReactNode;
  label: string;
  onError?: () => void;
  className?: string;
  onActivate?: () => void;
  onDispose?: () => void;
  style?: CSSProperties;
}, { failed: boolean; error: unknown }> {
  state = { failed: false, error: null as unknown };
  static getDerivedStateFromError(error: unknown) { return { failed: true, error }; }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    this.props.onError?.();
    console.error(`${this.props.label} render error:`, error, info.componentStack);
  }
  componentWillUnmount() {
    // A failed child already unmounted; release resources retained for Retry
    // when its owner removes the fallback as well.
    if (this.state.failed) this.props.onDispose?.();
  }
  render() {
    if (!this.state.failed) return this.props.children;
    return <section className={`aya-local-error${this.props.className ? ` ${this.props.className}` : ''}`} style={this.props.style} role="alert" onMouseDown={this.props.onActivate}>
      <strong>{this.props.label} could not be displayed</strong>
      <p>The rest of your workspace is still available.</p>
      <button type="button" onClick={() => this.setState({ failed: false, error: null })}>Retry {this.props.label.toLowerCase()}</button>
      <details><summary>Error details</summary><pre>{errorDetails(this.state.error, null)}</pre></details>
    </section>;
  }
}
