/**
 * A document panel's header tools: Build on a .tex file (it builds the
 * project and brings the PDF up), Edit / Split / Preview on the active
 * Markdown or HTML file, and on the active Paper Blog / Paper beside its own
 * Edit / Split / Preview (a Paper is Markdown too).
 *
 * The modes are icons, each named in its tooltip and to assistive technology;
 * a header with room to spare names them beside their icons too (see the
 * header's data-tools="named" in trellis.css).
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
import { useId, useState, useSyncExternalStore, type ReactNode } from "react";
import { useLingui } from "@lingui/react/macro";
import { useView } from "@danfessler/trellis-react";
import { Columns2, Eye, FileText, Newspaper, PenLine, Play } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tip } from "../components/icon-tip";
import { SegmentedControl } from "../components/ui/segmented-control";
import { InfinityLoader } from "../components/ui/activity-icons";
import { documentTools, useTrellisApp, type TrellisController, type TrellisViewMode } from "./trellis-controller";
import type { BuildOutcome } from "../app/use-build-pipeline";
import { buildHeadline } from "../build/build-result-text";

/**
 * When each build outcome was first shown. Its flourish belongs to the moment
 * the build ends, so a panel that remounts later (switching tabs or panels)
 * shows the finished check without celebrating it a second time. Every build
 * produces a new outcome object, so a WeakMap keyed by it forgets on its own.
 */
const outcomeShownAt = new WeakMap<BuildOutcome, number>();
const FLOURISH_WINDOW_MS = 900;
function isFreshOutcome(outcome: BuildOutcome | null): boolean {
  if (!outcome) return false;
  const now = performance.now();
  const shown = outcomeShownAt.get(outcome);
  if (shown === undefined) {
    outcomeShownAt.set(outcome, now);
    return true;
  }
  return now - shown < FLOURISH_WINDOW_MS;
}

/** Six short rays in the mark's two threads, thrown off a check that has just drawn itself. */
const BURST = Array.from({ length: 6 }, (_, index) => {
  const angle = (index * 60 - 90) * (Math.PI / 180);
  const at = (radius: number) => `${(12 + Math.cos(angle) * radius).toFixed(2)} ${(12 + Math.sin(angle) * radius).toFixed(2)}`;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- SVG path data
  return { d: `M${at(14)}L${at(18)}`, thread: index % 2 ? "warp" : "weft" };
});

/**
 * The build's result, drawn on the 24-unit icon grid of the lucide icons
 * beside it. A fresh clean success draws its check and throws a small burst;
 * a fresh failure draws its cross and shakes once. A success with warnings is
 * still a check, with a warning-colored dot set beside it like a footnote
 * mark: it draws its check and the dot settles in, without the burst a clean
 * build earns. Afterwards all of them rest.
 */
function BuildStatusGlyph({ status, warned, fresh }: { status: "succeeded" | "failed"; warned: boolean; fresh: boolean }) {
  return (
    <svg
      className="trellis-build-status"
      data-status={status}
      data-fresh={fresh || undefined}
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {status === "succeeded"
        ? <path className="trellis-build-stroke" pathLength={1} d="M20 6 9 17l-5-5" />
        : <>
          <path className="trellis-build-stroke" pathLength={1} d="M18 6 6 18" />
          <path className="trellis-build-stroke" pathLength={1} d="m6 6 12 12" />
        </>}
      {warned && <circle className="trellis-build-pip" cx={20.5} cy={18} r={3.5} stroke="none" />}
      {fresh && status === "succeeded" && !warned && (
        <g className="trellis-build-burst" strokeWidth={2}>
          {BURST.map(({ d, thread }) => <path key={d} d={d} data-thread={thread} />)}
        </g>
      )}
    </svg>
  );
}

/** "just now", "3 minutes ago": how long before `now` a build finished. */
function buildAge(finishedAt: number, now: number, justNow: string, locale: string): string {
  const seconds = Math.max(0, (now - finishedAt) / 1000);
  if (seconds < 45) return justNow;
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  if (seconds < 86_400) return format.format(-Math.round(seconds / 3600), "hour");
  return format.format(-Math.round(seconds / 86_400), "day");
}

/** Tools that hold their place in the header without being seen or reached. */
function Reserve({ children }: { children: ReactNode }) {
  return <span className="trellis-tools-reserve" inert aria-hidden="true">{children}</span>;
}

export function FileHeaderTools({ controller }: { controller: TrellisController }) {
  const { t, i18n } = useLingui();
  const view = useView<{ key: string }>();
  const key = view.params.key;
  const active = useTrellisApp(controller, (state) => state.activeKey === key);
  const tools = useSyncExternalStore(controller.docTools.subscribe, controller.docTools.get);
  const which = documentTools(controller.bridge?.tabKind(key) ?? "file", key);
  const resultId = useId();
  // The build's age is read when the writer reaches the button, by pointer or
  // by focus, so neither the tip nor the description is older than that.
  const [reachedAt, setReachedAt] = useState(Date.now);
  if (which === "build") {
    // Gray and labelled Build while idle; a running build shows a spinner in
    // place of the play icon, and another press queues a fresh build. Once it
    // ends the button reports it: a green check and the build's time, or a red
    // cross and "Failed", until the next build starts. The zh-CN label for
    // Build (构建) also reads as "building", so an unchanged label after a
    // build read as one that never finished.
    const { building, lastBuild } = tools;
    const seconds = lastBuild?.status === "succeeded" ? lastBuild.seconds.toFixed(1) : null;
    // Warnings never turn a build into a failure; they only mark its check.
    const warned = lastBuild?.status === "succeeded" && lastBuild.counts.error + lastBuild.counts.warning > 0;
    const headline = building
      ? t`Building…`
      : lastBuild ? buildHeadline(lastBuild.status === "succeeded", lastBuild.counts) : t`Build and show the PDF`;
    // What happened is followed by which document, how long the compile took
    // and how long ago it ended.
    const facts = !building && lastBuild
      ? [lastBuild.rootDocument, seconds && `${seconds}s`, buildAge(lastBuild.finishedAt, reachedAt, t`just now`, i18n.locale)]
        .filter((fact): fact is string => Boolean(fact))
      : [];
    const reach = () => setReachedAt(Date.now());
    const button = (live: boolean) => {
      const state = !live ? "idle" : building ? "building" : lastBuild?.status ?? "idle";
      const fresh = state !== "idle" && state !== "building" && isFreshOutcome(lastBuild);
      const labels = { build: t`Build`, failed: t`Failed`, time: seconds ? `${seconds}s` : "" };
      const shown = state === "succeeded" ? "time" : state === "failed" ? "failed" : "build";
      return (
        <button
          type="button"
          className={cn("trellis-build-button", state !== "idle" && `is-${state}`, live && warned && "has-warnings", fresh && "is-fresh")}
          aria-label={t`Build`}
          aria-describedby={live ? resultId : undefined}
          aria-busy={state === "building" || undefined}
          onPointerEnter={live ? reach : undefined}
          onFocus={live ? reach : undefined}
          onClick={live ? (event) => controller.bridge?.build(key, { clean: event.shiftKey, beside: view.panelId }) : undefined}
        >
          {state === "building" ? <InfinityLoader size={13} />
            : state === "succeeded" || state === "failed" ? <BuildStatusGlyph status={state} warned={warned} fresh={fresh} />
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
          {live && <span id={resultId} className="sr-only">{[headline, ...facts].join(" · ")}</span>}
        </button>
      );
    };
    if (!active) return <Reserve>{button(false)}</Reserve>;
    // The tip gives the same result as the description, then how to build again.
    const label = (
      <span className="trellis-build-tip">
        <span className="trellis-build-tip-headline">{headline}</span>
        {facts.length > 0 && (
          <span className="trellis-build-tip-facts">
            {facts.map((fact, index) => <span key={index}>{fact}</span>)}
          </span>
        )}
        <span className="trellis-build-tip-hint">{t`⌘S · ⇧-click for a clean rebuild`}</span>
      </span>
    );
    return <Tip label={label}>{button(true)}</Tip>;
  }
  if (which === null) return null;
  // Edit, Split and Preview: a Markdown or HTML file's, and a Paper's beside its Blog/Paper switch.
  const modeItems = [
    { value: "source" as const, label: <><PenLine size={13} /><span className="trellis-mode-name">{t`Edit`}</span></> },
    { value: "split" as const, label: <><Columns2 size={13} /><span className="trellis-mode-name">{t`Split`}</span></> },
    { value: "pdf" as const, label: <><Eye size={13} /><span className="trellis-mode-name">{t`Preview`}</span></> },
  ];
  const modes = active && tools.viewModes ? (
    <SegmentedControl<TrellisViewMode>
      value={tools.viewMode}
      onChange={(mode) => controller.bridge?.setViewMode(mode)}
      ariaLabel={t`Document view`}
      className="trellis-view-switcher"
      items={modeItems.map((item, i) => ({
        ...item,
        title: (tools.viewModes === "html"
          ? [t`Edit HTML`, t`Edit and preview HTML`, t`Preview HTML`]
          : [t`Edit Markdown`, t`Edit and preview Markdown`, t`Preview Markdown`])[i],
      }))}
    />
  ) : <Reserve><SegmentedControl<TrellisViewMode> value="source" onChange={() => {}} ariaLabel="" className="trellis-view-switcher" items={modeItems} /></Reserve>;
  if (which === "views") return modes;
  const items = [
    { value: "blog" as const, label: <><Newspaper size={13} /><span className="trellis-mode-name">{t`Blog`}</span></>, title: t`Open the paper overview` },
    { value: "fulltext" as const, label: <><FileText size={13} /><span className="trellis-mode-name">{t`Paper`}</span></>, title: t`Open the full paper Markdown` },
  ];
  // A Paper with only its full text or only its blog has nothing to switch
  // between, but keeps the switch's room like any other Paper. Short of
  // room (data-tools="icon"), the switch gives way before the modes; the
  // panel menu repeats both.
  const content = !active || !tools.paperViews || !tools.paperView
    ? <Reserve><SegmentedControl<"blog" | "fulltext"> value="blog" onChange={() => {}} ariaLabel="" className="trellis-view-switcher" items={items} /></Reserve>
    : (
      <SegmentedControl<"blog" | "fulltext">
        value={tools.paperView}
        onChange={(paperView) => controller.bridge?.setPaperView(paperView)}
        ariaLabel={t`Paper content`}
        className="trellis-view-switcher"
        items={items}
      />
    );
  return (
    <span className="trellis-paper-tools">
      <span className="trellis-paper-content">{content}</span>
      {modes}
    </span>
  );
}
