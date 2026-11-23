import { Component, type ErrorInfo, type ReactNode } from "react";
import { AppCrashCard } from "./AppCrashCard";
import { reportCrash } from "../lib/crashReport";

type Props = { children: ReactNode };
type State = { error: unknown; componentStack: string | null };

/**
 * The last place a render error can land.
 *
 * Without it a throw anywhere in the tree unmounts everything and leaves an
 * empty page — the crash that read as "the field turns a strange colour and
 * disappears" and left nothing to look at afterwards. A boundary cannot fix the
 * throw, but it keeps the app on screen and hands the reader a report.
 *
 * The dump is written here rather than from the card's first render: only
 * `componentDidCatch` carries the component stack, and that stack is what names
 * the component that died. A card-side effect would race it and file a report
 * without the one line worth having.
 */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null, componentStack: null };
  private reported = false;

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error };
  }

  componentDidCatch(error: unknown, info: ErrorInfo) {
    const componentStack = info.componentStack ?? null;
    this.setState({ componentStack });
    if (this.reported) return;
    this.reported = true;
    void reportCrash(error, componentStack).catch(() => {
      /* the card still carries the report by hand */
    });
  }

  render() {
    if (this.state.error !== null) {
      return (
        <AppCrashCard error={this.state.error} componentStack={this.state.componentStack} />
      );
    }
    return this.props.children;
  }
}
