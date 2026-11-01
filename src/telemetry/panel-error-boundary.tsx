/**
 * One panel's error boundary: a render error in the file tree, the editor,
 * the PDF, the Agent or a tool panel replaces that panel with a card offering
 * to reload it, and the rest of the window keeps working. Without one, the
 * error reached RootErrorBoundary, which unmounts all of App for the crash
 * page, taking every other panel (and any edit not yet written) with it.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { Button } from "../components/ui/button";
import { addAppLog } from "./app-log-store";
import { saveOnCrash } from "./crash-save";
import { i18n } from "../i18n";

type PanelErrorBoundaryProps = {
  /** Which panel, for the log entry. */
  name: string;
  children: ReactNode;
  /**
   * The panel's host element, for children that portal their content into it
   * (the document canvas, the PDF panel): the card goes there, where the
   * panel's content was. Without it the card renders in place.
   */
  host?: HTMLElement | null;
  /** A new value (another document opened, another project) gives the children another try. */
  resetKey?: unknown;
};

type PanelErrorBoundaryState = { error: Error | null };

export class PanelErrorBoundary extends Component<PanelErrorBoundaryProps, PanelErrorBoundaryState> {
  state: PanelErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): PanelErrorBoundaryState {
    // Here, not in componentDidCatch: by then React has run the crashed
    // tree's layout cleanups, and the visual editor's flush of its pending
    // edits unregisters in one (see crash-save.ts). Starting the save is
    // idempotent while it runs, so a render React retries starts it once.
    void saveOnCrash();
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    addAppLog({
      level: "error",
      // Panels render only after main.tsx activates the locale, so no English fallback is needed here.
      source: i18n._(msg`UI`),
      title: i18n._(msg`A panel crashed`),
      detail: `${this.props.name}\n${error.stack ?? error.message}\n${info.componentStack ?? ""}`,
      toast: false,
    });
  }

  componentDidUpdate(previous: PanelErrorBoundaryProps) {
    if (this.state.error && previous.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  private readonly reload = () => this.setState({ error: null });

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const card = <PanelErrorCard error={error} onReload={this.reload} />;
    return this.props.host ? createPortal(card, this.props.host) : card;
  }
}

function PanelErrorCard({ error, onReload }: { error: Error; onReload: () => void }) {
  const { t } = useLingui();
  return (
    <div className="panel-error" role="alert">
      <strong>{t`This panel stopped working`}</strong>
      <p>{t`The rest of the window keeps working.`}</p>
      <Button onClick={onReload}>{t`Reload panel`}</Button>
      <details className="root-error-details">
        <summary>{t`Technical details`}</summary>
        <pre>{error.stack || error.message}</pre>
      </details>
    </div>
  );
}
