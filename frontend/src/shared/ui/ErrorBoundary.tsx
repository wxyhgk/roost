import { Component, type ReactNode } from "react";
import { t } from "@roost/i18n";

type Props = {
  children: ReactNode;
  region?: string;
  /**
   * 崩了之后画什么。
   *
   * 给**有降级路径**的地方用：一个专用渲染器炸了，正确的结果是退回通用那条路，而不是在
   * 对话里留一块「XX 不可用」。没有降级路径的地方照旧显示错误——那种时候藏起来才是坏的。
   */
  fallback?: ReactNode;
};
type State = { error: Error | null };

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
    if (this.state.error) {
      if (this.props.fallback !== undefined) return this.props.fallback;
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
