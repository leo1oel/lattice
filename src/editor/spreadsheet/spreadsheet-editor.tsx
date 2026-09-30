import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as Y from "yjs";
import { CommandType, DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY, type IWorkbookData } from "@univerjs/core";
import type { FWorkbook } from "@univerjs/preset-sheets-core";
import { isRecord } from "../../app-utils";
import { logAction } from "../../telemetry/app-notify";
import type { SpreadsheetFileViewState } from "../../app-types";
import { ExternalScrollbar } from "../../components/ui/external-scrollbar";
import { whenIdle } from "../../app/effect-helpers";
import { utf8ToBase64 } from "../../pdf/pdf-bytes";
import { registerAgentSpreadsheetDocument } from "../../agent/agent-spreadsheet-tools";
import { clone, inBounds, jsonEqual, type SpreadsheetCellData, type SpreadsheetWorkbookData } from "./spreadsheet-types";
import {
  SPREADSHEET_MESSAGES,
  appearanceDefaultStyle,
  applyRenderAppearance,
  applyUniverTheme,
  createSpreadsheetUniver,
  spreadsheetAppearance,
  withSpreadsheetAppearance,
} from "./spreadsheet-univer";
import {
  SPREADSHEET_LOCAL_ORIGIN,
  SpreadsheetDocumentError,
  applySpreadsheetCellChanges,
  reconcileSpreadsheetDocChanges,
  replaceSpreadsheetDocFromSource,
  seedSpreadsheetDoc,
  spreadsheetDocContent,
  spreadsheetSnapshotFromDoc,
} from "./spreadsheet-yjs";

const SERIALIZE_DEBOUNCE_MS = 300;
const SERIALIZE_IDLE_TIMEOUT_MS = 1_000;
const MAX_PATCHED_REMOTE_CELLS = 1_000;
const SET_RANGE_VALUES_MUTATION = "sheet.mutation.set-range-values";
const FUNCTIONS_PANEL_SELECTOR = '[data-u-comp="sheets-formula-functions-panel"]';
const VIEW_KEYS = ["zoomRatio", "scrollTop", "scrollLeft"] as const;

export type SpreadsheetEditorProps = {
  path: string;
  source: string;
  onChange: (next: string) => void;
  onPersist: () => Promise<boolean>;
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  active?: boolean;
  initialViewState?: SpreadsheetFileViewState;
  onViewState?: (state: SpreadsheetFileViewState) => void;
};

type SheetView = Pick<SpreadsheetWorkbookData["sheets"][string], (typeof VIEW_KEYS)[number]>;
type LocalCellChange = { row: number; column: number; previous: SpreadsheetCellData | null; next: SpreadsheetCellData | null };

/** Copy per-user scroll/zoom onto a snapshot; view state never reaches the shared file. */
function withSheetViews(snapshot: SpreadsheetWorkbookData, views: Record<string, SheetView | undefined>): SpreadsheetWorkbookData {
  const output = clone(snapshot);
  for (const sheetId of output.sheetOrder) {
    const view = views[sheetId];
    const sheet = output.sheets[sheetId];
    if (view && sheet) for (const key of VIEW_KEYS) sheet[key] = view[key];
  }
  return output;
}

/** Univer's save() with the stored `defaultStyle` restored in place of the display-only appearance style. */
function commandSnapshot(workbook: FWorkbook, canonical: SpreadsheetWorkbookData): SpreadsheetWorkbookData {
  const snapshot = workbook.save() as unknown as SpreadsheetWorkbookData;
  for (const sheetId of snapshot.sheetOrder) {
    const source = canonical.sheets[sheetId];
    const target = snapshot.sheets[sheetId];
    if (!source || !target) continue;
    if (Object.hasOwn(source, "defaultStyle")) target.defaultStyle = clone(source.defaultStyle);
    else delete target.defaultStyle;
  }
  return snapshot;
}

/** Sheet order, names and dimensions: what a cell-level patch cannot change. */
function structureFingerprint(workbook: SpreadsheetWorkbookData): string {
  return JSON.stringify(workbook.sheetOrder.map((id) => {
    const sheet = workbook.sheets[id];
    return [id, sheet?.id, sheet?.name, sheet?.rowCount, sheet?.columnCount];
  }));
}

function workbookViewState(workbook: FWorkbook): SpreadsheetFileViewState {
  const activeSheet = workbook.getActiveSheet();
  return {
    activeSheetId: activeSheet.getSheetId(),
    activeRange: activeSheet.getActiveRange()?.getA1Notation(),
    activeCell: activeSheet.getActiveCell()?.getA1Notation(),
    sheets: Object.fromEntries(workbook.getSheets().map((sheet) => {
      const { scrollTop, scrollLeft } = sheet.getSheet().getScrollLeftTopFromSnapshot();
      return [sheet.getSheetId(), { zoomRatio: sheet.getZoom(), scrollTop, scrollLeft }];
    })),
  };
}

function restoreWorkbookViewState(workbook: FWorkbook, state: SpreadsheetFileViewState): void {
  const sheet = workbook.getSheetBySheetId(state.activeSheetId);
  if (!sheet) return;
  try {
    workbook.setActiveSheet(sheet);
    if (state.activeRange) sheet.getRange(state.activeRange).activate();
    if (state.activeCell) sheet.getRange(state.activeCell).activateAsCurrentCell();
  } catch {
    // An Agent or on-disk row/column deletion can invalidate the old selection
    // while the sheet itself remains. Univer's default selection is valid then.
  }
}

function unionKeys(...records: object[]): string[] {
  return [...new Set(records.flatMap((record) => Object.keys(record)))];
}

function changedCells(previous: SpreadsheetWorkbookData, next: SpreadsheetWorkbookData) {
  const changed: Array<{ sheetId: string; row: number; column: number; value: Record<string, unknown> | null }> = [];
  for (const sheetId of next.sheetOrder) {
    const before = previous.sheets[sheetId]?.cellData ?? {};
    const after = next.sheets[sheetId]?.cellData ?? {};
    for (const row of unionKeys(before, after).map(Number)) {
      const beforeRow = before[row] ?? {};
      const afterRow = after[row] ?? {};
      for (const column of unionKeys(beforeRow, afterRow).map(Number)) {
        if (!jsonEqual(beforeRow[column], afterRow[column])) changed.push({ sheetId, row, column, value: afterRow[column] ? clone(afterRow[column]) : null });
      }
    }
  }
  return changed;
}

/** A plain value edit Univer reported cell by cell; null when it needs a full workbook save instead. */
function localCellMutation(
  id: string,
  params: unknown,
  workbook: FWorkbook,
  snapshot: SpreadsheetWorkbookData,
): { sheetId: string; changes: LocalCellChange[] } | null {
  if (id !== SET_RANGE_VALUES_MUTATION || !isRecord(params) || typeof params.subUnitId !== "string" || !isRecord(params.cellValue)) return null;
  const sheetId = params.subUnitId;
  const worksheet = workbook.getSheetBySheetId(sheetId);
  const sheet = snapshot.sheets[sheetId];
  if (!worksheet || !sheet) return null;
  const changes: LocalCellChange[] = [];
  for (const [rowKey, columns] of Object.entries(params.cellValue)) {
    const row = Number(rowKey);
    if (!inBounds(row, sheet.rowCount) || !isRecord(columns)) return null;
    for (const column of Object.keys(columns).map(Number)) {
      if (!inBounds(column, sheet.columnCount)) return null;
      const previous = sheet.cellData[row]?.[column] ?? null;
      const raw = worksheet.getSheet().getCellRaw(row, column);
      const next = isRecord(raw) ? clone(raw) as SpreadsheetCellData : null;
      // A new style ID requires the workbook style catalog from a full save.
      if (!jsonEqual(previous?.s, next?.s)) return null;
      if (!jsonEqual(previous, next)) changes.push({ row, column, previous, next });
    }
  }
  return { sheetId, changes };
}

function updateSnapshotCells(sheet: SpreadsheetWorkbookData["sheets"][string], changes: LocalCellChange[]): void {
  for (const { row, column, next } of changes) {
    if (next) {
      (sheet.cellData[row] ??= {})[column] = clone(next);
    } else if (sheet.cellData[row]) {
      delete sheet.cellData[row][column];
      if (Object.keys(sheet.cellData[row]).length === 0) delete sheet.cellData[row];
    }
  }
}

/**
 * The workbook lives in a Y.Doc the editor owns: Univer edits land in it as
 * local transactions, while the Agent's batches and external file changes land
 * as foreign ones the mounted surface renders back.
 */
export function SpreadsheetEditor(props: SpreadsheetEditorProps) {
  const { path, source } = props;
  const { i18n } = useLingui();
  const localState = useMemo(() => {
    const doc = new Y.Doc();
    try {
      if (source) doc.getText("content").insert(0, source);
      seedSpreadsheetDoc(doc);
      return { doc, error: null };
    } catch (error) {
      doc.destroy();
      return { doc: null, error };
    }
  // The canvas remounts this editor per path; external source changes are
  // reconciled by the mounted surface rather than replacing the Y.Doc identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);
  useEffect(() => () => localState.doc?.destroy(), [localState.doc]);

  if (!localState.doc) {
    const { error } = localState;
    const detail = error instanceof SpreadsheetDocumentError
      ? i18n._(error.descriptor)
      : error instanceof Error && error.message ? error.message : i18n._(msg`Invalid .lattice-sheet document`);
    return (
      <div className="spreadsheet-editor-root spreadsheet-editor-error" role="alert">
        <strong>{i18n._(msg`Couldn’t open this spreadsheet`)}</strong>
        <span>{detail}</span>
      </div>
    );
  }
  return <SpreadsheetEditorSurface {...props} doc={localState.doc} />;
}

function SpreadsheetEditorSurface({
  path, source, onChange, onPersist, onFlushPendingChange, active = true, initialViewState, onViewState, doc,
}: SpreadsheetEditorProps & { doc: Y.Doc }) {
  const { i18n } = useLingui();
  // eslint-disable-next-line lingui/no-unlocalized-strings -- locale tags
  const interfaceLocale = i18n.locale === "zh-CN" ? "zh-CN" : "en";
  const containerRef = useRef<HTMLDivElement>(null);
  const workbookRef = useRef<FWorkbook | null>(null);
  const callbacks = useRef({ onChange, onPersist, onViewState });
  const initialViewStateRef = useRef(initialViewState);
  const exportingRef = useRef(false);
  const exportExcelRef = useRef<() => void>(() => {});
  const flushRef = useRef<() => void>(() => {});
  const localSourceRef = useRef(source);
  const [functionsPanelOpen, setFunctionsPanelOpen] = useState(false);
  const getSidebarScrollViewport = useCallback(() => containerRef.current?.querySelector<HTMLElement>('[data-u-comp="sidebar"] > section') ?? null, []);
  const getFunctionsScrollViewport = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(`${FUNCTIONS_PANEL_SELECTOR} ul.univer-overflow-y-auto`) ?? null, []);

  useLayoutEffect(() => { callbacks.current = { onChange, onPersist, onViewState }; });
  useLayoutEffect(() => {
    exportExcelRef.current = () => {
      const workbook = workbookRef.current;
      if (!workbook || exportingRef.current) return;
      const fileName = path.split(/[\\/]/).at(-1)?.replace(/\.lattice-sheet$/i, ".xlsx") || "spreadsheet.xlsx";
      const trace = logAction(i18n._(msg`Spreadsheet`), i18n._(SPREADSHEET_MESSAGES.exportMenu), fileName);
      exportingRef.current = true;
      void (async () => {
        try {
          const destination = await saveDialog({
            title: i18n._(SPREADSHEET_MESSAGES.exportDialogTitle),
            defaultPath: fileName,
            filters: [{ name: i18n._(SPREADSHEET_MESSAGES.exportFileType), extensions: ["xlsx"] }],
          });
          if (!destination) return;
          const snapshot = commandSnapshot(workbook, spreadsheetSnapshotFromDoc(doc));
          const { spreadsheetWorkbookToXlsx } = await import("./spreadsheet-xlsx");
          const bytes = await spreadsheetWorkbookToXlsx(snapshot);
          const savedPath = await invoke<string>("save_xlsx", bytes.buffer, {
            headers: { "x-xlsx-destination": utf8ToBase64(destination) },
          });
          trace.ok(i18n._(msg`Excel workbook exported`), { detail: savedPath });
        } catch (reason) {
          trace.fail(reason instanceof SpreadsheetDocumentError ? new Error(i18n._(reason.descriptor)) : reason);
        } finally {
          exportingRef.current = false;
        }
      })();
    };
    return () => { exportExcelRef.current = () => {}; };
  }, [doc, i18n, path]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const syncFunctionsPanel = () => setFunctionsPanelOpen(Boolean(host.querySelector(FUNCTIONS_PANEL_SELECTOR)));
    const observer = new MutationObserver(syncFunctionsPanel);
    observer.observe(host, { childList: true, subtree: true });
    syncFunctionsPanel();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!source.trim() || source === localSourceRef.current) return;
    if (source !== spreadsheetDocContent(doc)) replaceSpreadsheetDocFromSource(doc, source);
    localSourceRef.current = source;
  }, [doc, source]);

  useEffect(() => {
    if (!containerRef.current) return;
    const initialSnapshot = spreadsheetSnapshotFromDoc(doc);
    let appearance = spreadsheetAppearance(containerRef.current);
    const { univer, univerAPI, baseTheme, renderManager } = createSpreadsheetUniver(
      containerRef.current,
      appearance,
      interfaceLocale,
      (message) => i18n._(message),
      () => exportExcelRef.current(),
    );
    let disposed = false;
    // Canvas chrome renders asynchronously; retry for ~30 frames until it exists.
    let renderAppearanceFrame: number | null = null;
    const scheduleRenderAppearance = () => {
      if (renderAppearanceFrame !== null) cancelAnimationFrame(renderAppearanceFrame);
      let attempts = 0;
      const apply = () => {
        renderAppearanceFrame = null;
        if (disposed || applyRenderAppearance(renderManager, workbook.getId(), appearance)) return;
        if (++attempts < 30) renderAppearanceFrame = requestAnimationFrame(apply);
      };
      apply();
    };
    let workbook = univerAPI.createWorkbook(withSpreadsheetAppearance(
      withSheetViews(initialSnapshot, initialViewStateRef.current?.sheets ?? {}),
      appearance,
    ) as unknown as IWorkbookData);
    if (initialViewStateRef.current) restoreWorkbookViewState(workbook, initialViewStateRef.current);
    scheduleRenderAppearance();
    const renderCreatedSubscription = renderManager.created$.subscribe((render) => {
      if (render.unitId === workbook.getId() || render.unitId === DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY) scheduleRenderAppearance();
    });
    workbookRef.current = workbook;
    let renderedSnapshot = initialSnapshot;
    let applyingRemote = false;
    let localSyncQueued = false;
    let remoteSyncQueued = false;
    // Univer mutations issued while applying foreign/appearance changes must not echo back into the Y.Doc.
    const asRemote = (apply: () => void) => {
      applyingRemote = true;
      try { apply(); } finally { applyingRemote = false; }
    };
    let viewStateFrame: number | null = null;
    const scheduleViewState = () => {
      viewStateFrame ??= requestAnimationFrame(() => {
        viewStateFrame = null;
        if (!disposed) callbacks.current.onViewState?.(workbookViewState(workbook));
      });
    };

    const replaceWorkbook = (next: SpreadsheetWorkbookData) => asRemote(() => {
      const viewState = workbookViewState(workbook);
      const display = withSpreadsheetAppearance(withSheetViews(next, commandSnapshot(workbook, renderedSnapshot).sheets), appearance);
      univerAPI.disposeUnit(workbook.getId());
      workbook = univerAPI.createWorkbook(display as unknown as IWorkbookData);
      workbookRef.current = workbook;
      scheduleRenderAppearance();
      restoreWorkbookViewState(workbook, viewState);
      renderedSnapshot = next;
    });

    const applyRemoteSnapshot = () => {
      remoteSyncQueued = false;
      if (disposed) return;
      const next = spreadsheetSnapshotFromDoc(doc);
      if (jsonEqual(next, renderedSnapshot)) return;
      const sameStructure = structureFingerprint(next) === structureFingerprint(renderedSnapshot);
      const cells = sameStructure ? changedCells(renderedSnapshot, next) : [];
      if (cells.length > 0 && cells.length <= MAX_PATCHED_REMOTE_CELLS) {
        asRemote(() => {
          for (const { sheetId, row, column, value } of cells) {
            if (!workbook.getSheetBySheetId(sheetId)) continue;
            // Explicit nulls clear fields the remote cell no longer has.
            const cell = value && { v: null, f: null, p: null, si: null, custom: null, ref: null, xf: null, s: null, ...value };
            univerAPI.syncExecuteCommand(SET_RANGE_VALUES_MUTATION, {
              unitId: workbook.getId(),
              subUnitId: sheetId,
              cellValue: { [row]: { [column]: cell } },
            }, { onlyLocal: true, fromCollab: true });
          }
          renderedSnapshot = next;
        });
      } else if (sameStructure) {
        renderedSnapshot = next;
      } else {
        replaceWorkbook(next);
      }
    };

    let appearanceSyncQueued = false;
    const appearanceObserver = new MutationObserver(() => {
      if (appearanceSyncQueued) return;
      appearanceSyncQueued = true;
      queueMicrotask(() => {
        appearanceSyncQueued = false;
        if (disposed || !containerRef.current) return;
        appearance = spreadsheetAppearance(containerRef.current);
        applyUniverTheme(univer, baseTheme, appearance);
        scheduleRenderAppearance();
        asRemote(() => {
          for (const sheetId of renderedSnapshot.sheetOrder) {
            workbook.getSheetBySheetId(sheetId)?.setDefaultStyle(appearanceDefaultStyle(renderedSnapshot, sheetId, appearance));
          }
        });
      });
    });
    appearanceObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });

    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === SPREADSHEET_LOCAL_ORIGIN || remoteSyncQueued) return;
      remoteSyncQueued = true;
      queueMicrotask(applyRemoteSnapshot);
    };
    doc.on("afterTransaction", onTransaction);

    const commandListener = univerAPI.onCommandExecuted((command) => {
      scheduleViewState();
      const commandUnitId = (command.params as { unitId?: unknown } | undefined)?.unitId;
      if (command.type !== CommandType.MUTATION || (commandUnitId !== undefined && commandUnitId !== workbook.getId())) return;
      if (applyingRemote || localSyncQueued) return;
      const cellMutation = localCellMutation(command.id, command.params, workbook, renderedSnapshot);
      if (cellMutation && applySpreadsheetCellChanges(doc, renderedSnapshot.sheets[cellMutation.sheetId], cellMutation.changes, SPREADSHEET_LOCAL_ORIGIN)) {
        updateSnapshotCells(renderedSnapshot.sheets[cellMutation.sheetId], cellMutation.changes);
        if (remoteSyncQueued) applyRemoteSnapshot();
        return;
      }
      localSyncQueued = true;
      queueMicrotask(() => {
        localSyncQueued = false;
        if (disposed || applyingRemote) return;
        // Scroll and zoom are view state, kept per user outside the file.
        const next = withSheetViews(commandSnapshot(workbook, renderedSnapshot), renderedSnapshot.sheets);
        if (jsonEqual(next, renderedSnapshot)) return;
        reconcileSpreadsheetDocChanges(doc, renderedSnapshot, next, SPREADSHEET_LOCAL_ORIGIN);
        renderedSnapshot = next;
        // A remote transaction can land after the command event but before
        // this microtask. Render the merged Y.Doc immediately so the local
        // snapshot neither erases that update nor hides it in Univer.
        applyRemoteSnapshot();
      });
    });

    const viewEvents = [univerAPI.Event.SelectionChanged, univerAPI.Event.ActiveSheetChanged]
      .map((event) => univerAPI.addEvent(event, scheduleViewState));
    return () => {
      if (viewStateFrame !== null) cancelAnimationFrame(viewStateFrame);
      callbacks.current.onViewState?.(workbookViewState(workbook));
      disposed = true;
      for (const event of viewEvents) event.dispose();
      commandListener.dispose();
      appearanceObserver.disconnect();
      if (renderAppearanceFrame !== null) cancelAnimationFrame(renderAppearanceFrame);
      renderCreatedSubscription.unsubscribe();
      doc.off("afterTransaction", onTransaction);
      workbookRef.current = null;
      // Univer owns a nested React root inside the host. Disposing it during
      // this outer root's passive cleanup makes React 19 report a synchronous
      // nested-root unmount race. Let the outer commit finish first; the host
      // may be detached by then, but Univer can still release that root and its
      // canvas resources on the next task.
      setTimeout(() => univer.dispose(), 0);
    };
  }, [doc, i18n, interfaceLocale, path]);

  useLayoutEffect(() => registerAgentSpreadsheetDocument(path, {
    doc,
    canWrite: true,
    path,
    commit: async () => {
      flushRef.current();
      // eslint-disable-next-line lingui/no-unlocalized-strings -- returned to the Agent as a tool error
      if (!(await callbacks.current.onPersist())) throw new Error("Lattice could not persist the spreadsheet update.");
    },
  }, active), [active, doc, path]);

  useEffect(() => {
    // Cancels the pending debounce or idle serialization; null when nothing is pending.
    let cancelScheduled: (() => void) | null = null;
    const flush = () => {
      cancelScheduled?.();
      cancelScheduled = null;
      const content = spreadsheetDocContent(doc);
      localSourceRef.current = content;
      callbacks.current.onChange(content);
    };
    const onUpdate = () => {
      cancelScheduled?.();
      const timer = setTimeout(() => {
        // Canonical source generation still walks every row. Keep that work
        // out of active typing and scrolling while preserving explicit flushes.
        cancelScheduled = whenIdle(flush, SERIALIZE_IDLE_TIMEOUT_MS, 0);
      }, SERIALIZE_DEBOUNCE_MS);
      cancelScheduled = () => clearTimeout(timer);
    };
    const flushPending = () => { if (cancelScheduled) flush(); };
    doc.on("update", onUpdate);
    flushRef.current = flushPending;
    return () => {
      doc.off("update", onUpdate);
      flushPending();
      flushRef.current = () => {};
    };
  }, [doc]);

  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    onFlushPendingChange(() => { flushRef.current(); return true; });
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);

  return (
    <div className="spreadsheet-editor-root" data-tour="spreadsheet-workspace">
      <div ref={containerRef} className="spreadsheet-univer-host" />
      <ExternalScrollbar getViewport={getSidebarScrollViewport} />
      {functionsPanelOpen && (
        <div className="spreadsheet-functions-scrollbar-surface">
          <ExternalScrollbar getViewport={getFunctionsScrollViewport} />
        </div>
      )}
    </div>
  );
}
