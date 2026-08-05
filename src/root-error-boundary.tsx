import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { Button } from "./components/ui/button";
import { addAppLog } from "./app-log-store";

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
  const restart = async () => {
    setActionError("");
    try {
      await onRestart();
    } catch {
      setActionError("Lattice couldn’t restart automatically. Quit and reopen it manually.");
    }
  };
  const copyDetails = async () => {
    setActionError("");
    try {
      await onCopyDetails(details);
      setCopied(true);
    } catch {
      setActionError("Couldn’t copy the details. Expand Technical details and copy them manually.");
    }
  };

  return (
    <main className="root-error-page">
      <section className="root-error-card" role="alert" aria-labelledby="root-error-title">
        <p className="root-error-eyebrow">Recovery</p>
        <h1 id="root-error-title">Lattice couldn’t open this window</h1>
        <p>
          Your project files are safe. Restart Lattice to reopen the window, or copy the error details
          if the problem continues.
        </p>
        <div className="root-error-actions">
          <Button variant="primary" onClick={() => void restart()}>
            Restart Lattice
          </Button>
          <Button onClick={() => void copyDetails()}>
            {copied ? "Error details copied" : "Copy error details"}
          </Button>
        </div>
        {actionError && <p className="root-error-action-error" role="alert">{actionError}</p>}
        <details className="root-error-details">
          <summary>Technical details</summary>
          <pre>{details}</pre>
        </details>
      </section>
    </main>
  );
}

export class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Write directly to the log store (not console.error, which the global
    // capture already wraps) so the crash lands in the on-disk log file.
    addAppLog({
      level: "error",
      source: "UI",
      title: "Lattice UI crashed",
      detail: `${error.stack ?? error.message}\n${info.componentStack ?? ""}`,
      toast: false,
    });
  }

  render() {
    if (this.state.error) {
      return <RootErrorFallback error={this.state.error} />;
    }
    return this.props.children;
  }
}
