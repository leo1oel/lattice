/**
 * A document panel's content: the live editor host for the active document,
 * an open deck's own host, and for every other document a read-only snapshot
 * or a sleeping card (see trellis-workspace.tsx).
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useLingui } from "@lingui/react/macro";
import { useCloseGuard, useView, useViewBadge } from "@danfessler/trellis-react";
import { BookOpen } from "lucide-react";
import { confirmAction, isOpenSlideDeckPath } from "../app-utils";
import { Tip } from "../components/icon-tip";
import { ProjectAssetPreview } from "../canvas/project-asset-preview";
import type { AssetPreview } from "../app-types";
import { useTrellisApp, type TrellisController } from "./trellis-controller";
import { fileIcon } from "./trellis-icons";
import { useFileTab } from "./trellis-document-tabs";
import type { FileParams } from "./trellis-tab-policy";
import { AfterSwitch } from "../canvas/after-switch";
import { isProjectFileMissing } from "../pdf/project-pdf-refusals";
import { useProjectPdfWatch } from "../pdf/use-project-pdf-watch";
import { ReadOnlyMarkdown, TextSnapshot } from "./trellis-text-snapshot";
import { useBesideActive } from "./use-beside-active";
import { EmptyState, HostSlot } from "./trellis-panel-views";
import { HIBERNATE_AFTER_MS, isHeavyDocument } from "./use-hibernation";

/**
 * A document that is not drawn right now (asleep, or a live editor paused
 * while hidden): its icon and name as one button, a press away from open.
 */
function SleepingDocument({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
  const bridge = controller.bridge;
  const kind = bridge?.tabKind(fileKey) ?? "file";
  return (
    <EmptyState
      icon={fileIcon(fileKey, kind, 16)}
      title={bridge?.tabLabel(fileKey) ?? fileKey}
      onActivate={() => controller.activate(fileKey)}
    />
  );
}

/**
 * A Paper that is not the active document, drawn read-only where it was being
 * read, so the Reading layout keeps it legible beside the notes being
 * written. It scrolls in place, and the place it is left at is where the full
 * reader, brought back by its header's button, picks up.
 */
function PaperSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  if (!useBesideActive(controller, panelId)) return <SleepingDocument controller={controller} fileKey={fileKey} />;
  return <PaperSnapshotContent controller={controller} fileKey={fileKey} />;
}

function PaperSnapshotContent({ controller, fileKey }: { controller: TrellisController; fileKey: string }) {
  const { t } = useLingui();
  const [paper, setPaper] = useState<{ path: string; text: string } | null | undefined>(undefined);
  useEffect(() => {
    let disposed = false;
    void controller.bridge?.readPaper(fileKey).then((value) => {
      if (!disposed) setPaper(value);
    }, () => {
      if (!disposed) setPaper(null);
    });
    return () => { disposed = true; };
  }, [controller, fileKey]);
  if (paper === null) return <SleepingDocument controller={controller} fileKey={fileKey} />;
  return (
    <div className="trellis-paper-snapshot">
      {/* The reader's own header, so the text holds its place when the reader comes back. */}
      <header className="paper-reader-header">
        <div className="paper-local-actions">
          {/* Named apart from its text, which a narrow header hides; the tip
              then names the bare icon. */}
          <Tip label={t`Open the reader`}>
            <button type="button" className="paper-local-action" aria-label={t`Open the reader`} onClick={() => controller.activate(fileKey)}>
              <BookOpen size={14} aria-hidden="true" />
              <span>{t`Open the reader`}</span>
            </button>
          </Tip>
        </div>
      </header>
      {paper && <ReadOnlyMarkdown controller={controller} path={paper.path} text={paper.text} />}
    </div>
  );
}

/**
 * A project PDF (or image) that is not the active document, kept open where
 * it was being read: the Reading layout pairs a PDF with the notes being
 * written, and a sleeping card there would hide it at the moment the notes
 * are typed. It is the asset preview itself, sharing the reader's page and
 * zoom both ways.
 */
function AssetSnapshot({ controller, fileKey, panelId }: { controller: TrellisController; fileKey: string; panelId: string }) {
  const besideActive = useBesideActive(controller, panelId);
  const [asset, setAsset] = useState<AssetPreview | null | undefined>(undefined);
  const [missing, setMissing] = useState(false);
  // A rewrite on disk hands the viewer the new version, as the live document
  // host does; a removed file stays open with a notice until it is back.
  const [recheck, setRecheck] = useState(0);
  const projectRoot = useTrellisApp(controller, (state) => state.projectRoot);
  useProjectPdfWatch(besideActive && (asset === null || asset?.ranges) ? projectRoot : null, fileKey, missing, () => setRecheck((count) => count + 1));
  useEffect(() => {
    if (!besideActive) return;
    let disposed = false;
    void controller.bridge?.readAsset(fileKey).then((value) => {
      if (disposed) return;
      setMissing(false);
      setAsset((current) => (current && current.ranges?.version === value.ranges?.version ? current : value));
    }, (reason: unknown) => {
      if (disposed) return;
      setAsset((current) => current ?? null);
      if (isProjectFileMissing(reason)) setMissing(true);
    });
    return () => { disposed = true; };
  }, [besideActive, controller, fileKey, recheck]);
  // Paging, zooming or searching the PDF beside the notes keeps the notes
  // active: the focus Trellis reports for it would otherwise activate the PDF
  // and replace this viewer, and the field just clicked, with the live host.
  // Native capture listeners, so they run after the workspace root's release
  // and before the deferred activation (React's would run ahead of the root's).
  // Its tab stays the way to open the PDF itself.
  const holdReading = useCallback((element: HTMLDivElement | null) => {
    if (!element) return;
    const hold = () => controller.holdReading(fileKey);
    element.addEventListener("pointerdown", hold, true);
    element.addEventListener("focusin", hold, true);
    return () => {
      element.removeEventListener("pointerdown", hold, true);
      element.removeEventListener("focusin", hold, true);
    };
  }, [controller, fileKey]);
  if (!besideActive || asset === null) return <SleepingDocument controller={controller} fileKey={fileKey} />;
  if (!asset) return null;
  return (
    <div ref={holdReading} className="trellis-pdf-snapshot">
      {/* Laid out as the live document host lays out the preview. */}
      <div className="canvas-body">
        <AfterSwitch state={controller.switchState}>
          <ProjectAssetPreview
            asset={asset}
            missing={missing}
            viewState={controller.bridge?.viewState(fileKey)}
            onViewState={(update) => controller.bridge?.rememberViewState(fileKey, update)}
            onFileChanged={() => setRecheck((count) => count + 1)}
            onPdfTextSelect={(text, place) => controller.bridge?.pdfTextSelect(text, place)}
          />
        </AfterSwitch>
      </div>
    </div>
  );
}

export function FileView({ controller }: { controller: TrellisController }) {
  const { t } = useLingui();
  const view = useView<FileParams>();
  const key = view.params.key;
  const active = useTrellisApp(controller, (state) => state.activeKey === key);
  const dirty = useTrellisApp(controller, (state) => state.activeKey === key && state.activeDirty);
  const hibernated = useSyncExternalStore(controller.ui.subscribe, () => active && controller.ui.get().editorHibernated);
  useViewBadge(dirty ? true : null);
  // Lattice saves instead of discarding: a dirty document saves before its
  // panel closes, and a failed save asks before anything is lost.
  useCloseGuard(async () => {
    const state = controller.app.get();
    if (state.activeKey !== key || !state.activeDirty) return true;
    if (await controller.bridge?.save()) return true;
    const name = controller.bridge?.tabLabel(key) ?? key;
    return confirmAction({
      title: t`Unsaved changes`,
      message: t`${name} could not be saved. Close it and discard the unsaved changes?`,
      confirmLabel: t`Discard and close`,
      destructive: true,
    });
  });
  useEffect(() => {
    if (active) controller.ui.set({ editorVisible: view.visible });
  }, [active, controller, view.visible]);
  const surfaceIcon = useFileTab(controller, view);
  if (isOpenSlideDeckPath(key)) {
    return (
      <>
        {surfaceIcon}
        <DeckSlot controller={controller} fileKey={key} view={view} />
        {/* What App lays over the active document (a document opening) still shows over a deck. */}
        {active && <HostSlot host={controller.hosts.editor} className="trellis-deck-overlay" />}
      </>
    );
  }
  if (active) {
    return (
      <>
        {surfaceIcon}
        <HostSlot host={controller.hosts.editor} className="trellis-file-live" />
        {hibernated && <SleepingDocument controller={controller} fileKey={key} />}
      </>
    );
  }
  if (!view.visible) return <>{surfaceIcon}</>;
  const kind = controller.bridge?.tabKind(key) ?? "file";
  return (
    <>
      {surfaceIcon}
      {kind === "file" && !isHeavyDocument(key)
        ? <TextSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
        : kind === "paper"
          ? <PaperSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
          : kind === "asset"
            ? <AssetSnapshot controller={controller} fileKey={key} panelId={view.panelId} />
            : <SleepingDocument controller={controller} fileKey={key} />}
    </>
  );
}

/**
 * An open deck's own host, adopted for as long as its panel holds it, active
 * or not and selected or not: its Open Slide frame never leaves the page, so
 * nothing reloads it (Trellis keeps a view's content element in place while
 * the view exists, and only hides an unselected one). Its tab only goes to
 * sleep when its panel has been off screen for a while: hidden, or out of
 * the framing; an unselected tab in a panel on screen is a click away and
 * stays loaded.
 */
function DeckSlot({ controller, fileKey, view }: { controller: TrellisController; fileKey: string; view: { visible: boolean; selected: boolean; placement: string } }) {
  const onScreen = view.visible || (!view.selected && view.placement !== "hidden");
  useEffect(() => {
    if (onScreen) {
      controller.decks.setSleeping(fileKey, false);
      return;
    }
    const timer = window.setTimeout(() => controller.decks.setSleeping(fileKey, true), HIBERNATE_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [controller, fileKey, onScreen]);
  useEffect(() => () => controller.decks.setSleeping(fileKey, false), [controller, fileKey]);
  // An inactive deck streams nothing and holds the props it was last handed,
  // so working in it makes it the active document (see `decks.watchFocus`).
  const active = useTrellisApp(controller, (state) => state.activeKey === fileKey);
  useEffect(() => {
    if (active) return;
    // Left in the frame when another document became active without taking
    // focus (an agent opening a file), focus would already be where a press
    // back into the deck puts it.
    if (controller.decks.host(fileKey).contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    return controller.decks.watchFocus(fileKey);
  }, [active, controller, fileKey]);
  return <HostSlot host={controller.decks.host(fileKey)} className="trellis-file-live" />;
}
