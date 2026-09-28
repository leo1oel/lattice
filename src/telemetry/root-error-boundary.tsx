import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { Button } from "../components/ui/button";
import { addAppLog } from "./app-log-store";
import { translateOr } from "./early-i18n";

/*
 * The recovery page must render whatever broke, so it reads the shared i18n
 * instance rather than React context, and keeps English for a crash that lands
 * before any catalog is active.
 */
/* eslint-disable lingui/no-unlocalized-strings -- English fallback for the recovery page */
const COPY = {
  eyebrow: [msg`Recovery`, "Recovery"],
  heading: [msg`Lattice couldn’t open this window`, "Lattice couldn’t open this window"],
  body: [
    msg`Your project files are safe. Restart Lattice to reopen the window, or copy the error details if the problem continues.`,
    "Your project files are safe. Restart Lattice to reopen the window, or copy the error details if the problem continues.",
  ],
  restart: [msg`Restart Lattice`, "Restart Lattice"],
  copy: [msg`Copy error details`, "Copy error details"],
  copied: [msg`Error details copied`, "Error details copied"],
  details: [msg`Technical details`, "Technical details"],
  "restart-failed": [
    msg`Lattice couldn’t restart automatically. Quit and reopen it manually.`,
    "Lattice couldn’t restart automatically. Quit and reopen it manually.",
  ],
  "copy-failed": [
    msg`Couldn’t copy the details. Expand Technical details and copy them manually.`,
    "Couldn’t copy the details. Expand Technical details and copy them manually.",
  ],
  "crash-source": [msg`UI`, "UI"],
  "crash-title": [msg`Lattice UI crashed`, "Lattice UI crashed"],
} satisfies Record<string, [MessageDescriptor, string]>;
/* eslint-enable lingui/no-unlocalized-strings */

function copy(key: keyof typeof COPY): string {
  const [descriptor, english] = COPY[key];
  return translateOr(descriptor, english);
}

type RootErrorFallbackProps = {
  error: Error;
  onRestart?: () => Promise<void> | void;
  onCopyDetails?: (details: string) => Promise<void> | void;
};

async function restartApplication() {
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    window.location.reload();
  }
}

async function copyErrorDetails(details: string) {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(details);
  } catch {
    await navigator.clipboard.writeText(details);
  }
}

export function RootErrorFallback({
  error,
  onRestart = restartApplication,
  onCopyDetails = copyErrorDetails,
}: RootErrorFallbackProps) {
  const [copied, setCopied] = useState(false);
  const [actionError, setActionError] = useState("");
  const details = error.stack || error.message;
  /** Runs one recovery action, explaining the manual fallback when it fails. */
  const attempt = async (action: () => Promise<void> | void, failure: string) => {
    setActionError("");
    try {
      await action();
    } catch {
      setActionError(failure);
    }
  };
  const restart = () => attempt(onRestart, copy("restart-failed"));
  const copyDetails = () => attempt(async () => {
    await onCopyDetails(details);
    setCopied(true);
  }, copy("copy-failed"));

  return (
    <main className="root-error-page">
      <section className="root-error-card" role="alert" aria-labelledby="root-error-title">
        <p className="root-error-eyebrow">{copy("eyebrow")}</p>
        <h1 id="root-error-title">{copy("heading")}</h1>
        <p>{copy("body")}</p>
        <div className="root-error-actions">
          <Button variant="primary" onClick={() => void restart()}>
            {copy("restart")}
          </Button>
          <Button onClick={() => void copyDetails()}>
            {copied ? copy("copied") : copy("copy")}
          </Button>
        </div>
        {actionError && <p className="root-error-action-error" role="alert">{actionError}</p>}
        <details className="root-error-details">
          <summary>{copy("details")}</summary>
          <pre>{details}</pre>
        </details>
      </section>
    </main>
  );
}

export class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Write directly to the log store (not console.error, which the global
    // capture already wraps) so the crash lands in the on-disk log file.
    addAppLog({
      level: "error",
      source: copy("crash-source"),
      title: copy("crash-title"),
      detail: `${error.stack ?? error.message}\n${info.componentStack ?? ""}`,
      toast: false,
    });
  }

  render() {
    return this.state.error ? <RootErrorFallback error={this.state.error} /> : this.props.children;
  }
}
