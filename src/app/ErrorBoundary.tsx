import { Component, type ErrorInfo, type ReactNode } from "react";

import { reportError } from "../lib/errorlog.ts";

// Top-level render guard (improvement-6 2.2). A throw during render in either face
// would unmount the whole tree and leave the always-on-top widget a blank void with
// no trace. This catches it, logs the stack to june.log (2.1), and shows a minimal
// recoverable fallback instead of "June died".

interface Props {
  children: ReactNode;
}
interface State {
  failed: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { failed: false };

  static getDerivedStateFromError(): State {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    reportError(`render: ${error.message}\n${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <div className="error-fallback" role="alert">
          <p>June hit a display error.</p>
          <button onClick={() => window.location.reload()}>Reload</button>
        </div>
      );
    }
    return this.props.children;
  }
}
