import { Component, type ReactNode } from "react";
import { t } from "@roost/i18n";

type Props = { children: ReactNode; region?: string };
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.region) return <div role="alert" className="p-4 text-sm text-text-dim">
        <p>{t.misc.errorBoundary.unavailable(this.props.region)}{this.state.error.message}</p>
        <button className="mt-2 rounded border border-border px-3 py-1" onClick={() => this.setState({ error: null })}>{t.misc.errorBoundary.retry}</button>
      </div>;
      return (
        <pre className="m-0 whitespace-pre-wrap p-6 font-mono text-danger">
          {this.state.error.message}
          {"\n"}
          {this.state.error.stack}
        </pre>
      );
    }
    return this.props.children;
  }
}
