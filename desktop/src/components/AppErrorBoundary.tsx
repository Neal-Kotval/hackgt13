import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = { children: ReactNode };
type State = { error: Error | null };

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[desktop] React render failed:", error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;

    return (
      <div className="app-error" role="alert">
        <h1>Desktop UI failed</h1>
        <p>{this.state.error.message}</p>
        <p>
          If the desktop bridge is unavailable, quit this window and restart with{" "}
          <code>just desktop</code> from the repo root.        </p>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => this.setState({ error: null })}
        >
          Try again
        </button>
      </div>
    );
  }
}
