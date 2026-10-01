/**
 * A document panel's header tools: Build on a .tex file (it builds the
 * project and brings the PDF up), Edit / Split / Preview on the active
 * Markdown or HTML file, and Blog / Paper on the active Paper.
 *
 * Every document view's tools share one grid cell in its panel's header (see
 * trellis.css), and the Trellis patch measures that cell for the panel's
 * minimum. So a view whose tools are not live right now — an unselected tab,
 * a Paper with only one of its two texts, a document whose state is still
 * loading — keeps the same tools laid out, inert and invisible. The cell is
 * then as wide as the widest tools any of the panel's documents can show,
 * whichever tab is selected and whatever kind of document it holds, so tabs
 * never change width and never run under the header's actions.
 */
import { useSyncExternalStore, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { useView } from "@danfessler/trellis-react";
import { Check, Columns2, Eye, FileText, Newspaper, PenLine, Play, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "../components/icon-tip";
import { SegmentedControl } from "../components/ui/segmented-control";
import { InfinityLoader } from "../components/ui/activity-icons";
import { documentTools, useTrellisApp, type TrellisController, type TrellisViewMode } from "./trellis-controller";

/** Tools that hold their place in the header without being seen or reached. */
function Reserve({ children }: { children: ReactNode }) {
  return <span className="trellis-tools-reserve" inert aria-hidden="true">{children}</span>;
}

export function FileHeaderTools({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  const view = useView<{ key: string }>();
  const key = view.params.key;
  const active = useTrellisApp(controller, (state) => state.activeKey === key);
  const tools = useSyncExternalStore(controller.docTools.subscribe, controller.docTools.get);
  const which = documentTools(controller.bridge?.tabKind(key) ?? "file", key);
  if (which === "build") {
    // Gray and labelled Build while idle; a running build shows a spinner in
    // place of the play icon, and another press queues a fresh build. Once it
    // ends the button reports it: a green check and the build's time, or a red
    // cross and "Failed", until the next build starts. The zh-CN label for
    // Build (构建) also reads as "building", so an unchanged label after a
    // build read as one that never finished.
    const { building, lastBuild } = tools;
    const seconds = lastBuild?.status === "succeeded" ? lastBuild.seconds.toFixed(1) : null;
    const button = (live: boolean) => {
      const state = !live ? "idle" : building ? "building" : lastBuild?.status ?? "idle";
      const labels = { build: t`Build`, failed: t`Failed`, time: seconds ? `${seconds}s` : "" };
      const shown = state === "succeeded" ? "time" : state === "failed" ? "failed" : "build";
      return (
        <button
          type="button"
          className={cn("trellis-build-button", state !== "idle" && `is-${state}`)}
          aria-label={t`Build`}
          aria-busy={state === "building" || undefined}
          onClick={live ? (event) => controller.bridge?.build(key, { clean: event.shiftKey, beside: view.panelId }) : undefined}
        >
          {state === "building" ? <InfinityLoader size={13} />
            : state === "succeeded" ? <Check size={13} strokeWidth={2.5} className="trellis-build-status" />
              : state === "failed" ? <X size={13} strokeWidth={2.5} className="trellis-build-status" />
                : <Play size={11} fill="currentColor" />}
          {/* Every label is laid out in one cell, with a hidden widest time beside
              them, so the button keeps the width of the widest whatever it shows,
              and the header's measured tools with it. */}
          <span className="trellis-build-label">
            {(Object.keys(labels) as Array<keyof typeof labels>).map((name) => (
              <span key={name} className={name === shown ? undefined : "trellis-build-label-off"}>{labels[name]}</span>
            ))}
            <span className="trellis-build-label-off">{"000.0"}s</span>
          </span>
        </button>
      );
    };
    if (!active) return <Reserve>{button(false)}</Reserve>;
    const label = building
      ? t`Building… · the PDF refreshes when it finishes`
      : seconds
        ? t({ message: `Built in ${seconds}s · Build the project and show the PDF · ⌘S · Shift-click for a clean rebuild` })
        : lastBuild?.status === "failed"
          ? t`The last build failed · Build the project and show the PDF · ⌘S · Shift-click for a clean rebuild`
          : t`Build the project and show the PDF · ⌘S · Shift-click for a clean rebuild`;
    return <Tip label={label}>{button(true)}</Tip>;
  }
  if (which === "views") {
    const items = [
      { value: "source" as const, label: <><PenLine size={13} /><span className="sr-only">{t`Edit`}</span></> },
      { value: "split" as const, label: <><Columns2 size={13} /><span className="sr-only">{t`Split`}</span></> },
      { value: "pdf" as const, label: <><Eye size={13} /><span className="sr-only">{t`Preview`}</span></> },
    ];
    if (!active || !tools.viewModes) {
      return <Reserve><SegmentedControl<TrellisViewMode> value="source" onChange={() => {}} ariaLabel="" className="trellis-view-switcher" items={items} /></Reserve>;
    }
    const titles = tools.viewModes === "markdown"
      ? [t`Edit Markdown`, t`Edit and preview Markdown`, t`Preview Markdown`]
      : [t`Edit HTML`, t`Edit and preview HTML`, t`Preview HTML`];
    return (
      <SegmentedControl<TrellisViewMode>
        value={tools.viewMode}
        onChange={(mode) => controller.bridge?.setViewMode(mode)}
        ariaLabel={t`Document view`}
        className="trellis-view-switcher"
        items={items.map((item, i) => ({ ...item, title: titles[i] }))}
      />
    );
  }
  if (which === "paper") {
    const items = [
      { value: "blog" as const, label: <><Newspaper size={13} /><span className="sr-only">{t`Blog`}</span></>, title: t`Open the paper overview` },
      { value: "fulltext" as const, label: <><FileText size={13} /><span className="sr-only">{t`Paper`}</span></>, title: t`Open the full paper Markdown` },
    ];
    // A Paper with only its full text or only its blog has nothing to switch
    // between, but keeps the switch's room like any other Paper.
    if (!active || !tools.paperViews || !tools.paperView) {
      return <Reserve><SegmentedControl<"blog" | "fulltext"> value="blog" onChange={() => {}} ariaLabel="" className="trellis-view-switcher" items={items} /></Reserve>;
    }
    return (
      <SegmentedControl<"blog" | "fulltext">
        value={tools.paperView}
        onChange={(paperView) => controller.bridge?.setPaperView(paperView)}
        ariaLabel={t`Paper content`}
        className="trellis-view-switcher"
        items={items}
      />
    );
  }
  return null;
}
