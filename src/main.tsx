import "./polyfills";
import "./index.css";
import { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/instrument-serif/400.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import App from "./App";
import { UpdaterProvider, UpdateBanner } from "./app-updater";
import "./app-updater.css";

class RootErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Lattice UI crashed", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div style={{
          boxSizing: "border-box",
          minHeight: "100vh",
          padding: 24,
          fontFamily: "-apple-system, BlinkMacSystemFont, sans-serif",
          color: "#242426",
          background: "#f7f7f6",
        }}
        >
          <h1 style={{ fontSize: 18, margin: "0 0 8px" }}>Lattice hit a UI error</h1>
          <p style={{ fontSize: 13, color: "#77777d", lineHeight: 1.5 }}>
            Quit with ⌘Q and reopen. If it stays blank, reinstall from the latest zip.
          </p>
          <pre style={{
            marginTop: 16,
            padding: 12,
            borderRadius: 8,
            background: "#fff",
            border: "1px solid rgba(0,0,0,0.08)",
            fontSize: 11,
            whiteSpace: "pre-wrap",
          }}
          >
            {this.state.error.message}
          </pre>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <RootErrorBoundary>
    <UpdaterProvider>
      <App />
      <UpdateBanner corner="top-right" />
    </UpdaterProvider>
  </RootErrorBoundary>,
);
