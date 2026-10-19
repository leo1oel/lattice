/**
 * The live preview's state, as a small pill over the PDF: downloading rtex,
 * starting, the first layout, live, a layout catching up, or stopped. It
 * floats over the pages rather than joining the PDF toolbar, so it costs the
 * toolbar no width in a narrow panel.
 */
import { useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { RotateCw } from "lucide-react";
import { Tip } from "../components/icon-tip";
import type { LivePreviewSession, LivePreviewSnapshot } from "./live-preview-session";
import type { LivePreviewState } from "./use-live-preview";
import "./live-preview.css";

type Tone = "busy" | "live" | "pending" | "stopped";

export function LivePreviewStatus({ state, onRetry }: { state: LivePreviewState; onRetry: () => void }) {
  if (state.kind === "off") return null;
  if (state.kind === "running") return <RunningStatus session={state.session} onRetry={onRetry} />;
  return <StatusPill state={state} snapshot={null} onRetry={onRetry} />;
}

function RunningStatus({ session, onRetry }: { session: LivePreviewSession; onRetry: () => void }) {
  const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot);
  return <StatusPill state={{ kind: "running", session }} snapshot={snapshot} onRetry={onRetry} />;
}

function StatusPill({ state, snapshot, onRetry }: {
  state: LivePreviewState;
  snapshot: LivePreviewSnapshot | null;
  onRetry: () => void;
}) {
  const { t } = useLingui();
  const about = t`Live preview redraws the paragraph you are typing within milliseconds, with rtex and your own LuaLaTeX. Page breaks, references, the exported PDF and jumps to the source still come from the normal build.`;
  let tone: Tone = "busy";
  let label: string;
  let detail: string | null = null;
  if (state.kind === "downloading") {
    const percent = Math.round(state.progress * 100);
    label = t`Downloading rtex… ${percent}%`;
    detail = t`A one-time download of about 4 MB. Builds work as usual meanwhile.`;
  } else if (state.kind === "starting" || snapshot?.phase === "starting") {
    label = t`Starting live preview…`;
    detail = t`Loading your preamble into LuaLaTeX.`;
  } else if (state.kind === "failed") {
    tone = "stopped";
    label = t`Live preview stopped`;
    detail = state.message;
  } else if (snapshot?.phase === "first-layout") {
    label = t`First layout…`;
    detail = t`Typesetting the whole document once. Typing shows here as soon as it finishes.`;
  } else if (snapshot?.phase === "error") {
    tone = "stopped";
    label = t`Live preview stopped`;
    detail = snapshot.detail ?? t`rtex stopped. The PDF still updates with each build.`;
  } else if (snapshot?.phase === "paused") {
    tone = "pending";
    label = t`Live typing paused`;
    detail = t`rtex could not load the preamble for live typing. The preview still updates after each full layout and build.`;
  } else if (snapshot?.layoutPending) {
    tone = "pending";
    label = t`Layout updating`;
    detail = t`The paragraph you typed is shown. Page breaks and what follows it catch up in a moment.`;
  } else {
    tone = "live";
    label = t`Live`;
  }
  const stopped = tone === "stopped";
  const tip = [label, detail, about].filter(Boolean).join("\n\n");
  return (
    <div className="live-preview-status-host">
      <Tip label={<span className="live-preview-status-tip">{tip}</span>} side="top">
        {stopped ? (
          <button type="button" className="live-preview-status" data-tone={tone} onClick={onRetry} aria-label={t`${label}. Restart live preview`}>
            <span className="live-preview-status-dot" aria-hidden="true" />
            <span className="live-preview-status-label">{label}</span>
            <RotateCw size={11} aria-hidden="true" />
          </button>
        ) : (
          <span className="live-preview-status" data-tone={tone} role="status" tabIndex={0} aria-label={label}>
            <span className="live-preview-status-dot" aria-hidden="true" />
            <span className="live-preview-status-label">{label}</span>
          </span>
        )}
      </Tip>
    </div>
  );
}
