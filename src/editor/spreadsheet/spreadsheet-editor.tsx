import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { useLingui } from "@lingui/react";
import { invoke } from "@tauri-apps/api/core";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
  BorderStyleTypes,
  ColorKit,
  CommandType,
  DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY,
  IConfirmService,
  invertColorByMatrix,
  LocaleType,
  LogLevel,
  type Plugin,
  type PluginCtor,
  ThemeService,
  Univer,
  type IDisposable,
  type IWorkbookData,
} from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import {
  UniverSheetsCorePreset,
  type FWorkbook,
} from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import { IRenderManagerService, SHEET_VIEWPORT_KEY, type IScrollBarProps } from "@univerjs/engine-render";
import {
  IMenuManagerService,
  MenuItemType,
  UniverUIPlugin,
  type IConfirmPartMethodOptions,
} from "@univerjs/ui";
import { BehaviorSubject } from "rxjs";
import { logAction } from "../../telemetry/app-notify";
import { confirmAction } from "../../app-utils";
import type { SpreadsheetFileViewState } from "../../app-types";
import { ExternalScrollbar } from "../../components/ui/external-scrollbar";
import { utf8ToBase64 } from "../../pdf/pdf-bytes";
import { registerAgentSpreadsheetDocument } from "../../agent/agent-spreadsheet-tools";
import { a1Range, parseA1Range } from "./spreadsheet-operations";
import type {
  SpreadsheetCellData,
  SpreadsheetPresence,
  SpreadsheetPresenceUser,
  SpreadsheetWorkbookData,
} from "./spreadsheet-types";
import {
  SPREADSHEET_LOCAL_ORIGIN,
  applySpreadsheetCellChanges,
  reconcileSpreadsheetDocChanges,
  replaceSpreadsheetDocFromSource,
  seedSpreadsheetDoc,
  spreadsheetDocContent,
  spreadsheetSnapshotFromDoc,
} from "./spreadsheet-yjs";

const SERIALIZE_DEBOUNCE_MS = 300;
const SERIALIZE_IDLE_TIMEOUT_MS = 1_000;
const PRESENCE_THROTTLE_MS = 100;
const SPREADSHEET_PRESENCE_FIELD = "spreadsheetPresence";
const SPREADSHEET_AGENT_PRESENCE_FIELD = "spreadsheetAgentPresence";
const SPREADSHEET_SOURCE = "Spreadsheet";
const SET_RANGE_VALUES_MUTATION = "sheet.mutation.set-range-values";
const SPREADSHEET_FORMULAS_MENU_ID = "lattice.spreadsheet.formulas";
const SPREADSHEET_EXPORT_MENU_ID = "lattice.spreadsheet.export-xlsx";
const SPREADSHEET_FUNCTIONS_PANEL_SELECTOR = '[data-u-comp="sheets-formula-functions-panel"]';
const SPREADSHEET_FORMULA_SURFACE_LIGHT = "#FAFAFA";
const SPREADSHEET_CHROME_SURFACE_LIGHT = "#F4F4F5";
const SPREADSHEET_CHROME_SURFACE_DARK = "#18181A";
const COMMON_SPREADSHEET_FORMULAS = ["SUMIF", "SUM", "AVERAGE", "IF", "COUNT", "MAX", "MIN"] as const;
// Univer's protection rules are not part of Lattice's Yjs workbook schema yet.
// Hiding every entry point prevents a local-only rule from looking like a
// reliable permission boundary to collaborators or the Agent.
const SPREADSHEET_MENU_CONFIG = {
  "sheet.command.add-range-protection-from-toolbar": { hidden: true },
  "sheet.contextMenu.permission": { hidden: true },
  "sheet.command.add-range-protection-from-context-menu": { hidden: true },
  "sheet.command.set-range-protection-from-context-menu": { hidden: true },
  "sheet.command.delete-range-protection-from-context-menu": { hidden: true },
  "sheet.command.view-sheet-permission-from-context-menu": { hidden: true },
  "sheet.command.add-range-protection-from-sheet-bar": { hidden: true },
  "sheet.command.delete-worksheet-protection-from-sheet-bar": { hidden: true },
  "sheet.command.change-sheet-protection-from-sheet-bar": { hidden: true },
  "sheet.command.view-sheet-permission-from-sheet-bar": { hidden: true },
  // The simple ribbon has no tab strip. A compact Formulas selector is added to
  // the Start group below; remove Univer's category duplicates and the lone
  // Data action from that single row.
  "formula-ui.operation.insert-function.common": { hidden: true },
  "formula-ui.operation.insert-function.financial": { hidden: true },
  "formula-ui.operation.insert-function.logical": { hidden: true },
  "formula-ui.operation.insert-function.text": { hidden: true },
  "formula-ui.operation.insert-function.date": { hidden: true },
  "formula-ui.operation.insert-function.lookup": { hidden: true },
  "formula-ui.operation.insert-function.math": { hidden: true },
  "formula-ui.operation.insert-function.statistical": { hidden: true },
  "formula-ui.operation.insert-function.engineering": { hidden: true },
  "formula-ui.operation.insert-function.information": { hidden: true },
  "formula-ui.operation.insert-function.database": { hidden: true },
  "sheet.toolbar.text-to-number": { hidden: true },
};

type SpreadsheetAppearance = {
  background: string;
  foreground: string;
  surface: string;
  border: string;
  gridline: string;
  muted: string;
  dark: boolean;
};

type UniverTheme = ReturnType<ThemeService["getCurrentTheme"]>;
type TranslateMessage = (message: MessageDescriptor) => string;

const SPREADSHEET_CONFIRM_MESSAGES = {
  deleteWorksheetTitle: msg`Delete worksheet?`,
  deleteWorksheet: msg`The worksheet and all of its contents will be removed.`,
  deleteWorksheetPermanently: msg`The worksheet and all of its contents will be removed and cannot be recovered.`,
  continueTitle: msg`Continue?`,
  continueMessage: msg`Please confirm that you want to continue.`,
  delete: msg`Delete`,
  continue: msg`Continue`,
  cancel: msg`Cancel`,
};
const SPREADSHEET_EXPORT_MESSAGES = {
  menuLabel: msg`Export Excel`,
  dialogTitle: msg`Export Excel workbook`,
  fileType: msg`Excel workbook`,
};
const SPREADSHEET_FORMULA_MESSAGES = {
  menuLabel: msg`Formulas`,
  tooltip: msg`Insert a formula`,
  allFunctions: msg`All Functions…`,
};

function confirmLabelText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) {
    const text = value.map(confirmLabelText).filter(Boolean).join(" ").trim();
    return text || undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of ["title", "value", "label", "children"] as const) {
    const text = confirmLabelText(value[key]);
    if (text) return text;
  }
  if (isRecord(value.props)) return confirmLabelText(value.props.children);
  return undefined;
}

class LatticeSpreadsheetConfirmService implements IConfirmService<IConfirmPartMethodOptions>, IDisposable {
  readonly confirmOptions$ = new BehaviorSubject<IConfirmPartMethodOptions[]>([]);
  private readonly openRequests = new Map<string, symbol>();

  constructor(
    private readonly translate: TranslateMessage,
    private readonly locale: "en" | "zh-CN",
  ) {}

  open(params: IConfirmPartMethodOptions): IDisposable {
    const request = Symbol(params.id);
    this.openRequests.set(params.id, request);
    void this.confirm(params).then((confirmed) => {
      if (this.openRequests.get(params.id) !== request) return;
      this.openRequests.delete(params.id);
      if (confirmed) params.onConfirm?.();
      else params.onClose?.();
    });
    return {
      dispose: () => {
        if (this.openRequests.get(params.id) === request) this.openRequests.delete(params.id);
      },
    };
  }

  confirm(params: IConfirmPartMethodOptions): Promise<boolean> {
    const title = confirmLabelText(params.title);
    const description = confirmLabelText(params.children);
    const removeSheet = params.id === "sheet.confirm.remove-sheet";
    const irreversibleSheetRemoval = removeSheet && (this.locale === "zh-CN"
      ? description?.includes("删除后将不可找回")
      : description?.includes("not be retrieved after deletion"));
    const destructive = removeSheet || /\b(delete|remove|discard|overwrite)\b/i.test(`${title ?? ""} ${description ?? ""}`);
    return confirmAction({
      title: removeSheet
        ? this.translate(SPREADSHEET_CONFIRM_MESSAGES.deleteWorksheetTitle)
        : title ?? this.translate(SPREADSHEET_CONFIRM_MESSAGES.continueTitle),
      message: removeSheet
        ? irreversibleSheetRemoval
          ? this.translate(SPREADSHEET_CONFIRM_MESSAGES.deleteWorksheetPermanently)
          : this.translate(SPREADSHEET_CONFIRM_MESSAGES.deleteWorksheet)
        : description ?? this.translate(SPREADSHEET_CONFIRM_MESSAGES.continueMessage),
      confirmLabel: removeSheet
        ? this.translate(SPREADSHEET_CONFIRM_MESSAGES.delete)
        : confirmLabelText(params.confirmText) ?? this.translate(SPREADSHEET_CONFIRM_MESSAGES.continue),
      cancelLabel: confirmLabelText(params.cancelText) ?? this.translate(SPREADSHEET_CONFIRM_MESSAGES.cancel),
      destructive,
    });
  }

  close(id: string): void {
    this.openRequests.delete(id);
  }

  dispose(): void {
    this.openRequests.clear();
    this.confirmOptions$.complete();
  }
}

export type SpreadsheetCollabBinding = {
  doc: Y.Doc;
  awareness: Awareness | null;
  user: SpreadsheetPresenceUser | null;
  canWrite: boolean;
  commit?: () => Promise<void>;
};

export type SpreadsheetEditorProps = {
  path: string;
  source: string;
  onChange: (next: string) => void;
  onPersist: () => Promise<boolean>;
  collab?: SpreadsheetCollabBinding | null;
  onFlushPendingChange?: (flush: (() => boolean) | null) => void;
  active?: boolean;
  initialViewState?: SpreadsheetFileViewState;
  onViewState?: (state: SpreadsheetFileViewState) => void;
};

type SpreadsheetEditorSurfaceProps = SpreadsheetEditorProps & {
  doc: Y.Doc;
  localDoc: Y.Doc | null;
};

type RemotePresence = {
  key: string;
  clientId: number;
  user: SpreadsheetPresenceUser;
  presence: SpreadsheetPresence;
};

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function asWorkbookData(value: IWorkbookData): SpreadsheetWorkbookData {
  return value as unknown as SpreadsheetWorkbookData;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function resolvedToken(styles: CSSStyleDeclaration, name: string, fallback: string): string {
  let value = styles.getPropertyValue(name).trim();
  const visited = new Set<string>();
  while (value.startsWith("var(") && value.endsWith(")")) {
    const variable = value.slice(4, -1).split(",", 1)[0].trim();
    if (!variable.startsWith("--") || visited.has(variable)) return fallback;
    visited.add(variable);
    value = styles.getPropertyValue(variable).trim();
  }
  return value || fallback;
}

function visibleColor(value: string, fallback: string): string {
  return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
}

function spreadsheetAppearance(container: HTMLElement): SpreadsheetAppearance {
  const rootStyles = getComputedStyle(document.documentElement);
  const styles = getComputedStyle(container);
  return {
    background: visibleColor(resolvedToken(rootStyles, "--editor-bg", styles.backgroundColor), "#f9f9fa"),
    foreground: visibleColor(resolvedToken(rootStyles, "--text-primary", styles.color), "#242426"),
    surface: resolvedToken(rootStyles, "--surface-panel-raised", resolvedToken(rootStyles, "--panel-strong", "#f9f9fa")),
    border: visibleColor(resolvedToken(rootStyles, "--border-subtle", styles.borderColor), "rgba(28, 28, 31, 0.09)"),
    gridline: visibleColor(resolvedToken(rootStyles, "--border-strong", styles.borderColor), "rgba(28, 28, 31, 0.14)"),
    muted: visibleColor(resolvedToken(rootStyles, "--text-tertiary", styles.outlineColor), "#6c6c72"),
    dark: document.documentElement.dataset.theme === "dark",
  };
}

function themeForAppearance(baseTheme: UniverTheme, appearance: SpreadsheetAppearance): UniverTheme {
  const { background, foreground, surface, border, gridline, muted, dark } = appearance;
  return {
    ...baseTheme,
    // The worksheet defaults reference these theme slots so Univer does not
    // run its dark-mode color inversion over Lattice's already-dark colors.
    // Text utilities that reference `white` are corrected in the scoped host CSS.
    white: background,
    black: dark ? background : foreground,
    gray: dark
      ? {
          ...baseTheme.gray,
          50: foreground,
          100: foreground,
          // Univer shares this slot between grid lines and the canvas beyond
          // the worksheet bounds. A translucent border keeps both subtle.
          200: gridline,
          // Univer's freeze handles use gray.300 at rest and gray.500 on
          // hover. Giving the resting state Lattice's subtle border preserves
          // its native enter/leave behavior without exposing the full-size
          // transparent drag targets.
          300: border,
          400: muted,
          500: muted,
          600: border,
          700: surface,
          800: background,
          900: background,
        }
      : {
          ...baseTheme.gray,
          50: background,
          100: surface,
          200: border,
          300: border,
          400: muted,
          500: muted,
          600: foreground,
          700: foreground,
          800: foreground,
          900: foreground,
        },
  };
}

function appearanceDefaultStyle(
  workbook: SpreadsheetWorkbookData,
  sheetId: string,
  appearance: SpreadsheetAppearance,
): Record<string, unknown> {
  const defaultStyle = workbook.sheets[sheetId]?.defaultStyle;
  const existing = typeof defaultStyle === "string"
    ? workbook.styles[defaultStyle]
    : defaultStyle;
  return {
    bg: { rgb: appearance.dark ? "white" : appearance.background },
    cl: { rgb: appearance.dark ? "gray.50" : appearance.foreground },
    bd: {
      b: {
        s: BorderStyleTypes.THIN,
        // Univer inverts literal Canvas colors in dark mode. Supplying the
        // inverse neutral yields the same translucent light gridline token.
        cl: { rgb: appearance.dark ? "rgba(0, 0, 0, 0.12)" : appearance.gridline },
      },
      r: {
        s: BorderStyleTypes.THIN,
        cl: { rgb: appearance.dark ? "rgba(0, 0, 0, 0.12)" : appearance.gridline },
      },
    },
    ...(isRecord(existing) ? clone(existing) : {}),
  };
}

function withSpreadsheetAppearance(
  snapshot: SpreadsheetWorkbookData,
  appearance: SpreadsheetAppearance,
): SpreadsheetWorkbookData {
  const output = clone(snapshot);
  for (const sheetId of output.sheetOrder) {
    output.sheets[sheetId].defaultStyle = appearanceDefaultStyle(snapshot, sheetId, appearance);
  }
  return output;
}

function commandSnapshot(
  workbook: FWorkbook,
  canonical: SpreadsheetWorkbookData,
): SpreadsheetWorkbookData {
  const snapshot = asWorkbookData(workbook.save());
  for (const sheetId of snapshot.sheetOrder) {
    const source = canonical.sheets[sheetId];
    const target = snapshot.sheets[sheetId];
    if (!source || !target) continue;
    if (Object.prototype.hasOwnProperty.call(source, "defaultStyle")) {
      target.defaultStyle = clone(source.defaultStyle);
    } else {
      delete target.defaultStyle;
    }
  }
  return snapshot;
}

function applyUniverTheme(
  univer: Univer,
  baseTheme: UniverTheme,
  appearance: SpreadsheetAppearance,
): void {
  const themeService = univer.__getInjector().get(ThemeService);
  themeService.setTheme(themeForAppearance(baseTheme, appearance));
  themeService.setDarkMode(appearance.dark);
}

function applyHeaderAppearance(
  renderManager: IRenderManagerService,
  unitId: string,
  appearance: SpreadsheetAppearance,
): boolean {
  const render = renderManager.getRenderById(unitId);
  if (!render) return false;
  const headerSurface = appearance.dark
    ? SPREADSHEET_CHROME_SURFACE_DARK
    : SPREADSHEET_CHROME_SURFACE_LIGHT;
  const headerStyle = {
    backgroundColor: headerSurface,
    borderColor: appearance.border,
    fontColor: appearance.muted,
  };
  const rowHeader = render.components.get("__SpreadsheetRowHeader__");
  const columnHeader = render.components.get("__SpreadsheetColumnHeader__");
  const corner = render.components.get("__SpreadsheetLeftTopPlaceholder__");
  if (
    !rowHeader || !("setCustomHeader" in rowHeader) || typeof rowHeader.setCustomHeader !== "function"
    || !columnHeader || !("setCustomHeader" in columnHeader) || typeof columnHeader.setCustomHeader !== "function"
    || !corner || !("setProps" in corner) || typeof corner.setProps !== "function"
  ) return false;
  rowHeader.setCustomHeader({ headerStyle });
  columnHeader.setCustomHeader({ headerStyle });
  const shape = corner as unknown as {
    setProps(props: { fill: string; stroke: string }): { makeDirty(): unknown };
  };
  shape.setProps({ fill: headerSurface, stroke: appearance.border }).makeDirty();
  rowHeader.makeDirty(true);
  columnHeader.makeDirty(true);
  render.scene.makeDirty();
  return true;
}

function spreadsheetScrollConfig(appearance: SpreadsheetAppearance): IScrollBarProps {
  const hover = appearance.dark ? "rgba(233, 233, 231, 0.12)" : "rgba(36, 36, 38, 0.12)";
  const active = appearance.dark ? "rgba(233, 233, 231, 0.16)" : "rgba(36, 36, 38, 0.16)";
  return {
    barSize: 8,
    barBorder: 0,
    thumbMargin: 2,
    thumbBackgroundColor: "transparent",
    thumbHoverBackgroundColor: hover,
    thumbActiveBackgroundColor: active,
    trackBackgroundColor: "transparent",
    trackBorderColor: "transparent",
  };
}

function applyScrollbarAppearance(
  renderManager: IRenderManagerService,
  unitId: string,
  appearance: SpreadsheetAppearance,
): boolean {
  const render = renderManager.getRenderById(unitId);
  const scrollbar = render?.scene.getViewport(SHEET_VIEWPORT_KEY.VIEW_MAIN)?.getScrollBar();
  if (!scrollbar) return false;
  const config = spreadsheetScrollConfig(appearance);
  scrollbar.setProps(config);
  scrollbar.horizonScrollTrack?.setProps({
    fill: config.trackBackgroundColor,
    stroke: config.trackBorderColor,
    strokeWidth: config.barBorder,
  });
  scrollbar.verticalScrollTrack?.setProps({
    fill: config.trackBackgroundColor,
    stroke: config.trackBorderColor,
    strokeWidth: config.barBorder,
  });
  scrollbar.placeholderBarRect?.setProps({
    fill: config.trackBackgroundColor,
    stroke: config.trackBorderColor,
    strokeWidth: config.barBorder,
  });
  scrollbar.horizonThumbRect?.setProps({ fill: config.thumbBackgroundColor });
  scrollbar.verticalThumbRect?.setProps({ fill: config.thumbBackgroundColor });
  scrollbar.makeDirty(true);
  return true;
}

function applyFormulaBarAppearance(
  renderManager: IRenderManagerService,
  appearance: SpreadsheetAppearance,
): boolean {
  const render = renderManager.getRenderById(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY);
  if (!render) return false;
  const canvas = render.engine.getCanvas().getCanvasEle();
  // The render unit exists before FormulaBar registers its visible editor.
  // Waiting for the connected, sized canvas prevents that registration from
  // immediately replacing our background with Univer's hard-coded white.
  if (!canvas.isConnected || canvas.width === 0 || canvas.height === 0) return false;
  const background = appearance.dark ? appearance.background : SPREADSHEET_FORMULA_SURFACE_LIGHT;
  canvas.style.backgroundColor = background;
  const rgb = new ColorKit(background).toRgb();
  const [renderRed, renderGreen, renderBlue] = appearance.dark
    ? invertColorByMatrix([rgb.r, rgb.g, rgb.b])
    : [rgb.r, rgb.g, rgb.b];
  const renderBackground = `rgb(${renderRed}, ${renderGreen}, ${renderBlue})`;
  const docBackground = render.components.get("__Document_Render_Background__");
  if (docBackground && "setFillColors" in docBackground && typeof docBackground.setFillColors === "function") {
    // Univer's dark canvas color service inverts literal paint colors. Feed it
    // the inverse so the rendered bitmap still lands on Lattice's background.
    docBackground.setFillColors(renderBackground, renderBackground, renderBackground, renderBackground);
  }
  render.scene.makeDirty();
  return true;
}

function createSpreadsheetUniver(
  container: HTMLElement,
  appearance: SpreadsheetAppearance,
  locale: "en" | "zh-CN",
  translate: TranslateMessage,
  onExportExcel: () => void,
): { univer: Univer; univerAPI: FUniver; baseTheme: UniverTheme } {
  const univerLocale = locale === "zh-CN" ? LocaleType.ZH_CN : LocaleType.EN_US;
  const univer = new Univer({
    locale: univerLocale,
    locales: {
      [LocaleType.EN_US]: enUS,
      [LocaleType.ZH_CN]: zhCN,
    },
    logLevel: LogLevel.WARN,
  });
  const baseTheme = univer.__getInjector().get(ThemeService).getCurrentTheme();
  applyUniverTheme(univer, baseTheme, appearance);
  const preset = UniverSheetsCorePreset({
    container,
    header: true,
    toolbar: true,
    ribbonType: "simple",
    formulaBar: true,
    footer: {},
    menu: SPREADSHEET_MENU_CONFIG,
    sheets: { scrollConfig: spreadsheetScrollConfig(appearance) },
  });
  const confirmService = new LatticeSpreadsheetConfirmService(
    translate,
    locale,
  );
  for (const entry of preset.plugins) {
    const [plugin, options] = Array.isArray(entry)
      ? entry
      : [entry, undefined] as [PluginCtor<Plugin>, undefined];
    if (plugin === UniverUIPlugin) {
      univer.registerPlugin(UniverUIPlugin, {
        ...options as ConstructorParameters<typeof UniverUIPlugin>[0],
        override: [[IConfirmService, { useValue: confirmService }]],
      });
      continue;
    }
    univer.registerPlugin(plugin, options);
  }
  univer.__getInjector().get(IMenuManagerService).mergeMenu({
    "ribbon.start.layout": {
      [SPREADSHEET_FORMULAS_MENU_ID]: {
        order: -2,
        menuItemFactory: () => ({
          id: SPREADSHEET_FORMULAS_MENU_ID,
          commandId: "formula-ui.operation.insert-function",
          title: translate(SPREADSHEET_FORMULA_MESSAGES.menuLabel),
          tooltip: translate(SPREADSHEET_FORMULA_MESSAGES.tooltip),
          icon: "FunctionIcon",
          type: MenuItemType.SELECTOR,
          selections: COMMON_SPREADSHEET_FORMULAS.map((formula) => ({
            label: { name: formula, selectable: false },
            value: formula,
          })),
        }),
        [`${SPREADSHEET_FORMULAS_MENU_ID}.all`]: {
          order: 0,
          menuItemFactory: () => ({
            id: "formula-ui.operation.more-functions",
            title: translate(SPREADSHEET_FORMULA_MESSAGES.allFunctions),
            type: MenuItemType.BUTTON,
          }),
        },
      },
    },
  });
  const univerAPI = FUniver.newAPI(univer);
  const exportExcelLabel = translate(SPREADSHEET_EXPORT_MESSAGES.menuLabel);
  univerAPI.createMenu({
    id: SPREADSHEET_EXPORT_MENU_ID,
    title: exportExcelLabel,
    tooltip: exportExcelLabel,
    icon: "ExportIcon",
    action: onExportExcel,
    order: Number.MAX_SAFE_INTEGER,
  }).appendTo("ribbon.start.others");
  return { univer, univerAPI, baseTheme };
}

function withSheetViewState(
  snapshot: SpreadsheetWorkbookData,
  viewSource: SpreadsheetWorkbookData,
): SpreadsheetWorkbookData {
  const output = clone(snapshot);
  for (const sheetId of output.sheetOrder) {
    const source = viewSource.sheets[sheetId];
    const sheet = output.sheets[sheetId];
    if (!source || !sheet) continue;
    sheet.scrollTop = source.scrollTop;
    sheet.scrollLeft = source.scrollLeft;
    sheet.zoomRatio = source.zoomRatio;
  }
  return output;
}

function withStoredSheetViewState(
  snapshot: SpreadsheetWorkbookData,
  state: SpreadsheetFileViewState | undefined,
): SpreadsheetWorkbookData {
  if (!state) return snapshot;
  const output = clone(snapshot);
  for (const [sheetId, view] of Object.entries(state.sheets)) {
    const sheet = output.sheets[sheetId];
    if (!sheet) continue;
    sheet.zoomRatio = view.zoomRatio;
    sheet.scrollTop = view.scrollTop;
    sheet.scrollLeft = view.scrollLeft;
  }
  return output;
}

function structureFingerprint(workbook: SpreadsheetWorkbookData): string {
  return JSON.stringify({
    sheetOrder: workbook.sheetOrder,
    sheets: Object.fromEntries(
      workbook.sheetOrder.map((id) => {
        const sheet = workbook.sheets[id];
        return [id, {
          id: sheet?.id,
          name: sheet?.name,
          rowCount: sheet?.rowCount,
          columnCount: sheet?.columnCount,
        }];
      }),
    ),
  });
}

function workbookViewState(workbook: FWorkbook): SpreadsheetFileViewState {
  const activeSheet = workbook.getActiveSheet();
  return {
    activeSheetId: activeSheet.getSheetId(),
    activeRange: activeSheet.getActiveRange()?.getA1Notation(),
    activeCell: activeSheet.getActiveCell()?.getA1Notation(),
    sheets: Object.fromEntries(workbook.getSheets().map((sheet) => {
      const { scrollTop, scrollLeft } = sheet.getSheet().getScrollLeftTopFromSnapshot();
      return [sheet.getSheetId(), {
        zoomRatio: sheet.getZoom(),
        scrollTop,
        scrollLeft,
      }];
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
    // A remote row/column deletion can invalidate the old selection while the
    // sheet itself remains. Univer's default selection is valid in that case.
  }
}

function changedCells(
  previous: SpreadsheetWorkbookData,
  next: SpreadsheetWorkbookData,
): Array<{ sheetId: string; row: number; column: number; value: Record<string, unknown> | null }> {
  const changed: Array<{ sheetId: string; row: number; column: number; value: Record<string, unknown> | null }> = [];
  for (const sheetId of next.sheetOrder) {
    const before = previous.sheets[sheetId]?.cellData ?? {};
    const after = next.sheets[sheetId]?.cellData ?? {};
    const rows = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const rowKey of rows) {
      const beforeRow = before[Number(rowKey)] ?? {};
      const afterRow = after[Number(rowKey)] ?? {};
      const columns = new Set([...Object.keys(beforeRow), ...Object.keys(afterRow)]);
      for (const columnKey of columns) {
        const beforeCell = beforeRow[Number(columnKey)];
        const afterCell = afterRow[Number(columnKey)];
        if (!sameJson(beforeCell, afterCell)) {
          changed.push({
            sheetId,
            row: Number(rowKey),
            column: Number(columnKey),
            value: afterCell ? JSON.parse(JSON.stringify(afterCell)) as Record<string, unknown> : null,
          });
        }
      }
    }
  }
  return changed;
}

type LocalCellChange = {
  row: number;
  column: number;
  previous: SpreadsheetCellData | null;
  next: SpreadsheetCellData | null;
};

function localCellMutation(
  id: string,
  params: unknown,
  workbook: FWorkbook,
  snapshot: SpreadsheetWorkbookData,
): { sheetId: string; changes: LocalCellChange[] } | null {
  if (id !== SET_RANGE_VALUES_MUTATION || !isRecord(params)) return null;
  const sheetId = params.subUnitId;
  if (typeof sheetId !== "string" || !isRecord(params.cellValue)) return null;
  const worksheet = workbook.getSheetBySheetId(sheetId);
  const snapshotSheet = snapshot.sheets[sheetId];
  if (!worksheet || !snapshotSheet) return null;
  const changes: LocalCellChange[] = [];
  for (const [rowKey, columns] of Object.entries(params.cellValue)) {
    const row = Number(rowKey);
    if (!Number.isSafeInteger(row) || row < 0 || row >= snapshotSheet.rowCount || !isRecord(columns)) return null;
    for (const columnKey of Object.keys(columns)) {
      const column = Number(columnKey);
      if (!Number.isSafeInteger(column) || column < 0 || column >= snapshotSheet.columnCount) return null;
      const previous = snapshotSheet.cellData[row]?.[column] ?? null;
      const rawNext = worksheet.getSheet().getCellRaw(row, column);
      const next = isRecord(rawNext) ? clone(rawNext) as SpreadsheetCellData : null;
      // A new style ID requires the workbook style catalog from a full save.
      if (!sameJson(previous?.s, next?.s)) return null;
      if (!sameJson(previous, next)) changes.push({ row, column, previous, next });
    }
  }
  return { sheetId, changes };
}

function updateSnapshotCells(sheet: SpreadsheetWorkbookData["sheets"][string], changes: LocalCellChange[]): void {
  for (const { row, column, next } of changes) {
    if (next) {
      (sheet.cellData[row] ??= {})[column] = clone(next);
      continue;
    }
    const cells = sheet.cellData[row];
    if (!cells) continue;
    delete cells[column];
    if (Object.keys(cells).length === 0) delete sheet.cellData[row];
  }
}

async function applyWorkbookPermission(workbook: FWorkbook, canWrite: boolean): Promise<void> {
  const permission = workbook.getWorkbookPermission();
  await (canWrite ? permission.setEditable() : permission.setReadOnly());
}

type PresencePopupProps = {
  popup: {
    extraProps?: {
      color?: string;
      name?: string;
    };
  };
};

function SpreadsheetPresencePopup({ popup }: PresencePopupProps) {
  const color = popup.extraProps?.color ?? "#6366f1";
  const name = popup.extraProps?.name ?? "Collaborator";
  return (
    // Univer's "top-left" direction places the popup immediately above its
    // range. Shift it by its own height so the pointer begins inside the cell.
    <div className="spreadsheet-remote-presence" style={{ color, transform: "translateY(100%)" }}>
      <svg viewBox="0 0 18 22" aria-hidden="true">
        <path d="M2 1 16 13l-7 .5-4 6.5z" fill="currentColor" stroke="white" strokeWidth="1.5" />
      </svg>
      <span style={{ backgroundColor: color }}>{name}</span>
    </div>
  );
}

function presenceRange(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  try {
    return parseA1Range(value).sheetName ? undefined : value;
  } catch {
    return undefined;
  }
}

function readRemotePresence(value: unknown, path: string): SpreadsheetPresence | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Partial<SpreadsheetPresence>;
  if (candidate.path !== path || typeof candidate.sheetId !== "string" || candidate.sheetId.length === 0 || candidate.sheetId.length > 128
    || !Array.isArray(candidate.selections) || candidate.selections.length > 32) return null;
  const selections = candidate.selections.map(presenceRange);
  if (selections.some((range) => range === undefined)) return null;
  const activeCell = candidate.activeCell === undefined ? undefined : presenceRange(candidate.activeCell);
  const editingCell = candidate.editingCell === undefined ? undefined : presenceRange(candidate.editingCell);
  if ((candidate.activeCell !== undefined && !activeCell) || (candidate.editingCell !== undefined && !editingCell)) return null;
  const pointer = candidate.pointer;
  if (pointer !== undefined && (!Number.isSafeInteger(pointer.row) || pointer.row < 0 || pointer.row >= 1_048_576
    || !Number.isSafeInteger(pointer.column) || pointer.column < 0 || pointer.column >= 16_384)) return null;
  return {
    path,
    sheetId: candidate.sheetId,
    selections: selections as string[],
    ...(activeCell ? { activeCell } : {}),
    ...(editingCell ? { editingCell } : {}),
    ...(pointer ? { pointer } : {}),
    ...(candidate.agent === true ? { agent: true } : {}),
  };
}

function attachSpreadsheetPresence(options: {
  api: FUniver;
  awareness: Awareness;
  path: string;
  user: SpreadsheetPresenceUser;
  onRemoteChange: (presence: RemotePresence[]) => void;
}): () => void {
  const { api, awareness, path, user, onRemoteChange } = options;
  let pending: SpreadsheetPresence | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let editingCell: string | undefined;
  const publish = () => {
    timer = null;
    awareness.setLocalStateField(SPREADSHEET_PRESENCE_FIELD, pending);
  };
  const schedule = (presence: SpreadsheetPresence) => {
    pending = presence;
    if (timer === null) timer = setTimeout(publish, PRESENCE_THROTTLE_MS);
  };
  const selection = api.addEvent(api.Event.SelectionChanged, ({ worksheet, selections }) => {
    schedule({
      path,
      sheetId: worksheet.getSheetId(),
      activeCell: selections[0] ? a1Range(selections[0]) : undefined,
      selections: selections.map((range) => a1Range(range)),
      ...(editingCell ? { editingCell } : {}),
    });
  });
  const pointer = api.addEvent(api.Event.CellPointerMove, ({ worksheet, row, column }) => {
    schedule({
      path,
      sheetId: worksheet.getSheetId(),
      activeCell: pending?.activeCell,
      selections: pending?.selections ?? [],
      pointer: { row, column, xRatio: 0.5, yRatio: 0.5 },
      ...(editingCell ? { editingCell } : {}),
    });
  });
  const editStarted = api.addEvent(api.Event.SheetEditStarted, ({ worksheet, row, column }) => {
    editingCell = a1Range({ startRow: row, endRow: row, startColumn: column, endColumn: column });
    schedule({ path, sheetId: worksheet.getSheetId(), activeCell: editingCell, selections: pending?.selections ?? [editingCell], editingCell });
  });
  const editEnded = api.addEvent(api.Event.SheetEditEnded, ({ worksheet }) => {
    editingCell = undefined;
    schedule({ path, sheetId: worksheet.getSheetId(), activeCell: pending?.activeCell, selections: pending?.selections ?? [] });
  });

  const applyRemote = () => {
    const remote: RemotePresence[] = [];
    for (const [clientId, state] of awareness.getStates()) {
      if (!state || typeof state !== "object") continue;
      const remoteUser = (state as { user?: Partial<SpreadsheetPresenceUser> }).user;
      for (const field of [SPREADSHEET_PRESENCE_FIELD, SPREADSHEET_AGENT_PRESENCE_FIELD] as const) {
        if (clientId === awareness.clientID && field === SPREADSHEET_PRESENCE_FIELD) continue;
        const presence = readRemotePresence((state as Record<string, unknown>)[field], path);
        if (!presence) continue;
        const agent = field === SPREADSHEET_AGENT_PRESENCE_FIELD;
        const collaboratorName = typeof remoteUser?.name === "string" && remoteUser.name.length > 0 && remoteUser.name.length <= 100
          ? remoteUser.name
          : "Collaborator";
        remote.push({
          key: `${clientId}:${field}`,
          clientId,
          presence,
          user: {
            id: typeof remoteUser?.id === "string" ? remoteUser.id : `peer:${clientId}`,
            name: agent ? `${collaboratorName}'s Agent` : collaboratorName,
            color: typeof remoteUser?.color === "string" && /^#[0-9a-f]{6}$/i.test(remoteUser.color)
              ? remoteUser.color
              : "#6366f1",
          },
        });
      }
    }
    onRemoteChange(remote);
  };
  awareness.on("change", applyRemote);
  applyRemote();

  // Keep identity on the existing shared awareness object without replacing
  // the controller's path/instance fields.
  awareness.setLocalState({
    ...(awareness.getLocalState() ?? {}),
    user: { ...(awareness.getLocalState()?.user as object ?? {}), ...user },
  });

  return () => {
    selection.dispose();
    pointer.dispose();
    editStarted.dispose();
    editEnded.dispose();
    if (timer !== null) clearTimeout(timer);
    awareness.off("change", applyRemote);
    awareness.setLocalStateField(SPREADSHEET_PRESENCE_FIELD, null);
    onRemoteChange([]);
  };
}

export function SpreadsheetEditor(props: SpreadsheetEditorProps) {
  const { path, source, collab } = props;
  const localState = useMemo(() => {
    if (collab?.doc) {
      try {
        spreadsheetSnapshotFromDoc(collab.doc);
        return { localDoc: null, error: null };
      } catch (error) {
        return {
          localDoc: null,
          error: error instanceof Error ? error.message : "Invalid .lattice-sheet document",
        };
      }
    }
    const doc = new Y.Doc();
    if (source) doc.getText("content").insert(0, source);
    try {
      seedSpreadsheetDoc(doc);
      return { localDoc: doc, error: null };
    } catch (error) {
      doc.destroy();
      return {
        localDoc: null,
        error: error instanceof Error ? error.message : "Invalid .lattice-sheet document",
      };
    }
  // The canvas remounts this editor per path; external source changes are
  // reconciled by the mounted surface rather than replacing the Y.Doc identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, collab?.doc]);
  useEffect(() => () => localState.localDoc?.destroy(), [localState.localDoc]);

  const doc = collab?.doc ?? localState.localDoc;
  if (!doc || localState.error) {
    return (
      <div className="spreadsheet-editor-root spreadsheet-editor-error" role="alert">
        <strong>Couldn’t open this spreadsheet</strong>
        <span>{localState.error ?? "Invalid .lattice-sheet document"}</span>
      </div>
    );
  }
  return <SpreadsheetEditorSurface {...props} doc={doc} localDoc={localState.localDoc} />;
}

function SpreadsheetEditorSurface({
  path,
  source,
  onChange,
  onPersist,
  collab,
  onFlushPendingChange,
  active = true,
  initialViewState,
  onViewState,
  doc,
  localDoc,
}: SpreadsheetEditorSurfaceProps) {
  const { i18n } = useLingui();
  const interfaceLocale = i18n.locale === "zh-CN" ? "zh-CN" : "en";
  const containerRef = useRef<HTMLDivElement>(null);
  const apiRef = useRef<FUniver | null>(null);
  const workbookRef = useRef<FWorkbook | null>(null);
  const onChangeRef = useRef(onChange);
  const onPersistRef = useRef(onPersist);
  const onViewStateRef = useRef(onViewState);
  const initialViewStateRef = useRef(initialViewState);
  const canWriteRef = useRef(collab?.canWrite !== false);
  const collabCommitRef = useRef(collab?.commit);
  const exportingRef = useRef(false);
  const exportExcelRef = useRef<() => void>(() => {});
  const permissionGenerationRef = useRef(0);
  const flushRef = useRef<() => void>(() => {});
  const localSourceRef = useRef(source);
  const [remotePresence, setRemotePresence] = useState<RemotePresence[]>([]);
  const [overlayTick, setOverlayTick] = useState(0);
  const [functionsPanelOpen, setFunctionsPanelOpen] = useState(false);
  const getSidebarScrollViewport = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(
      '[data-u-comp="sidebar"] > section',
    ) ?? null,
    [],
  );
  const getFunctionsScrollViewport = useCallback(
    () => containerRef.current?.querySelector<HTMLElement>(
      `${SPREADSHEET_FUNCTIONS_PANEL_SELECTOR} ul.univer-overflow-y-auto`,
    ) ?? null,
    [],
  );
  const setWorkbookPermission = useCallback((workbook: FWorkbook, canWrite: boolean) => {
    const host = containerRef.current;
    const generation = ++permissionGenerationRef.current;
    if (host) host.inert = true;
    void applyWorkbookPermission(workbook, canWrite).then(() => {
      if (permissionGenerationRef.current === generation && host) host.inert = false;
    }).catch(() => {
      // If Univer cannot establish read-only mode, leave the surface inert
      // instead of accepting edits that the collaboration layer must reject.
      if (canWrite && permissionGenerationRef.current === generation && host) host.inert = false;
    });
  }, []);

  useLayoutEffect(() => { onChangeRef.current = onChange; }, [onChange]);
  useLayoutEffect(() => { onPersistRef.current = onPersist; }, [onPersist]);
  useLayoutEffect(() => { onViewStateRef.current = onViewState; }, [onViewState]);
  useLayoutEffect(() => { collabCommitRef.current = collab?.commit; }, [collab?.commit]);
  useLayoutEffect(() => {
    exportExcelRef.current = () => {
      const workbook = workbookRef.current;
      if (!workbook || exportingRef.current) return;
      const fileName = path.split(/[\\/]/).at(-1)?.replace(/\.lattice-sheet$/i, ".xlsx") || "spreadsheet.xlsx";
      const trace = logAction(SPREADSHEET_SOURCE, "Export Excel", fileName);
      exportingRef.current = true;
      void (async () => {
        try {
          const destination = await saveDialog({
            title: i18n._(SPREADSHEET_EXPORT_MESSAGES.dialogTitle),
            defaultPath: fileName,
            filters: [{
              name: i18n._(SPREADSHEET_EXPORT_MESSAGES.fileType),
              extensions: ["xlsx"],
            }],
          });
          if (!destination) return;
          const snapshot = commandSnapshot(workbook, spreadsheetSnapshotFromDoc(doc));
          const { spreadsheetWorkbookToXlsx } = await import("./spreadsheet-xlsx");
          const bytes = await spreadsheetWorkbookToXlsx(snapshot);
          const savedPath = await invoke<string>("save_xlsx", bytes.buffer, {
            headers: { "x-xlsx-destination": utf8ToBase64(destination) },
          });
          trace.ok("Excel workbook exported", { detail: savedPath });
        } catch (reason) {
          trace.fail(reason);
        } finally {
          exportingRef.current = false;
        }
      })();
    };
    return () => { exportExcelRef.current = () => {}; };
  }, [doc, i18n, path]);
  useLayoutEffect(() => {
    canWriteRef.current = collab?.canWrite !== false;
    const workbook = workbookRef.current;
    if (workbook) setWorkbookPermission(workbook, canWriteRef.current);
  }, [collab?.canWrite, setWorkbookPermission]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const syncFunctionsPanel = () => {
      setFunctionsPanelOpen(Boolean(host.querySelector(SPREADSHEET_FUNCTIONS_PANEL_SELECTOR)));
    };
    const observer = new MutationObserver(syncFunctionsPanel);
    observer.observe(host, { childList: true, subtree: true });
    syncFunctionsPanel();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (collab?.doc || !localDoc) return;
    if (!source.trim()) return;
    if (source === localSourceRef.current) return;
    const current = spreadsheetDocContent(localDoc);
    if (source !== current) replaceSpreadsheetDocFromSource(localDoc, source);
    localSourceRef.current = source;
  }, [collab?.doc, localDoc, source]);

  useEffect(() => {
    if (!containerRef.current) return;
    if (canWriteRef.current) seedSpreadsheetDoc(doc);
    const initialSnapshot = spreadsheetSnapshotFromDoc(doc);
    let currentAppearance = spreadsheetAppearance(containerRef.current);
    const { univer, univerAPI, baseTheme } = createSpreadsheetUniver(
      containerRef.current,
      currentAppearance,
      interfaceLocale,
      (message) => i18n._(message),
      () => exportExcelRef.current(),
    );
    const renderManager = univer.__getInjector().get(IRenderManagerService);
    let disposed = false;
    let renderAppearanceFrame: number | null = null;
    const scheduleRenderAppearance = (unitId: string) => {
      if (renderAppearanceFrame !== null) cancelAnimationFrame(renderAppearanceFrame);
      let attempts = 0;
      const apply = () => {
        renderAppearanceFrame = null;
        if (disposed) return;
        const applied = [
          applyHeaderAppearance(renderManager, unitId, currentAppearance),
          applyScrollbarAppearance(renderManager, unitId, currentAppearance),
          applyFormulaBarAppearance(renderManager, currentAppearance),
        ];
        if (applied.every(Boolean)) return;
        attempts += 1;
        if (attempts < 30) renderAppearanceFrame = requestAnimationFrame(apply);
      };
      apply();
    };
    let workbook = univerAPI.createWorkbook(
      withSpreadsheetAppearance(
        withStoredSheetViewState(initialSnapshot, initialViewStateRef.current),
        currentAppearance,
      ) as unknown as IWorkbookData,
    );
    if (initialViewStateRef.current) restoreWorkbookViewState(workbook, initialViewStateRef.current);
    scheduleRenderAppearance(workbook.getId());
    const renderCreatedSubscription = renderManager.created$.subscribe((render) => {
      if (render.unitId === workbook.getId() || render.unitId === DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY) {
        scheduleRenderAppearance(workbook.getId());
      }
    });
    apiRef.current = univerAPI;
    workbookRef.current = workbook;
    setWorkbookPermission(workbook, canWriteRef.current);
    let renderedSnapshot = initialSnapshot;
    let applyingRemote = false;
    let localSyncQueued = false;
    let remoteSyncQueued = false;
    let viewStateFrame: number | null = null;
    const reportViewState = () => {
      viewStateFrame = null;
      if (disposed) return;
      onViewStateRef.current?.(workbookViewState(workbook));
    };
    const scheduleViewState = () => {
      if (viewStateFrame === null) viewStateFrame = requestAnimationFrame(reportViewState);
    };

    const replaceWorkbook = (next: SpreadsheetWorkbookData) => {
      applyingRemote = true;
      try {
        const viewState = workbookViewState(workbook);
        const displaySnapshot = withSpreadsheetAppearance(
          withSheetViewState(next, commandSnapshot(workbook, renderedSnapshot)),
          currentAppearance,
        );
        univerAPI.disposeUnit(workbook.getId());
        workbook = univerAPI.createWorkbook(displaySnapshot as unknown as IWorkbookData);
        workbookRef.current = workbook;
        scheduleRenderAppearance(workbook.getId());
        setWorkbookPermission(workbook, canWriteRef.current);
        restoreWorkbookViewState(workbook, viewState);
        renderedSnapshot = next;
      } finally {
        applyingRemote = false;
      }
    };

    const applyRemoteSnapshot = () => {
      remoteSyncQueued = false;
      if (disposed) return;
      const next = spreadsheetSnapshotFromDoc(doc);
      if (sameJson(next, renderedSnapshot)) return;
      const cells = structureFingerprint(next) === structureFingerprint(renderedSnapshot)
        ? changedCells(renderedSnapshot, next)
        : [];
      if (cells.length > 0 && cells.length <= 1_000) {
        applyingRemote = true;
        try {
          for (const change of cells) {
            const sheet = workbook.getSheetBySheetId(change.sheetId);
            if (!sheet) continue;
            const value = change.value
              ? {
                v: null,
                f: null,
                p: null,
                si: null,
                custom: null,
                ref: null,
                xf: null,
                s: null,
                ...change.value,
              }
              : null;
            univerAPI.syncExecuteCommand("sheet.mutation.set-range-values", {
              unitId: workbook.getId(),
              subUnitId: change.sheetId,
              cellValue: { [change.row]: { [change.column]: value } },
            }, { onlyLocal: true, fromCollab: true });
          }
          renderedSnapshot = next;
        } finally {
          applyingRemote = false;
        }
      } else if (structureFingerprint(next) === structureFingerprint(renderedSnapshot)) {
        renderedSnapshot = next;
      } else {
        replaceWorkbook(next);
      }
      setOverlayTick((tick) => tick + 1);
    };

    let appearanceSyncQueued = false;
    const applyAppearance = () => {
      appearanceSyncQueued = false;
      if (disposed || !containerRef.current) return;
      currentAppearance = spreadsheetAppearance(containerRef.current);
      applyUniverTheme(univer, baseTheme, currentAppearance);
      scheduleRenderAppearance(workbook.getId());
      applyingRemote = true;
      try {
        for (const sheetId of renderedSnapshot.sheetOrder) {
          workbook.getSheetBySheetId(sheetId)?.setDefaultStyle(
            appearanceDefaultStyle(renderedSnapshot, sheetId, currentAppearance),
          );
        }
      } finally {
        applyingRemote = false;
      }
      setOverlayTick((tick) => tick + 1);
    };
    const scheduleAppearanceSync = () => {
      if (appearanceSyncQueued) return;
      appearanceSyncQueued = true;
      queueMicrotask(applyAppearance);
    };
    const appearanceObserver = new MutationObserver(scheduleAppearanceSync);
    appearanceObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "style"],
    });

    const onTransaction = (transaction: Y.Transaction) => {
      if (transaction.origin === SPREADSHEET_LOCAL_ORIGIN || remoteSyncQueued) return;
      remoteSyncQueued = true;
      queueMicrotask(applyRemoteSnapshot);
    };
    doc.on("afterTransaction", onTransaction);

    const commandListener = univerAPI.onCommandExecuted((command) => {
      scheduleViewState();
      const commandUnitId = (command.params as { unitId?: unknown } | undefined)?.unitId;
      if (
        command.type !== CommandType.MUTATION
        || (commandUnitId !== undefined && commandUnitId !== workbook.getId())
      ) return;
      if (applyingRemote || localSyncQueued || !canWriteRef.current) return;
      const cellMutation = localCellMutation(command.id, command.params, workbook, renderedSnapshot);
      if (cellMutation && applySpreadsheetCellChanges(
        doc,
        renderedSnapshot.sheets[cellMutation.sheetId],
        cellMutation.changes,
        SPREADSHEET_LOCAL_ORIGIN,
      )) {
        updateSnapshotCells(renderedSnapshot.sheets[cellMutation.sheetId], cellMutation.changes);
        if (remoteSyncQueued) applyRemoteSnapshot();
        return;
      }
      localSyncQueued = true;
      queueMicrotask(() => {
        localSyncQueued = false;
        if (disposed || applyingRemote || !canWriteRef.current) return;
        // Scroll and zoom are local view state. Keeping the last collaborative
        // values prevents one user's navigation from moving every peer.
        const next = withSheetViewState(commandSnapshot(workbook, renderedSnapshot), renderedSnapshot);
        if (sameJson(next, renderedSnapshot)) return;
        reconcileSpreadsheetDocChanges(doc, renderedSnapshot, next, SPREADSHEET_LOCAL_ORIGIN);
        renderedSnapshot = next;
        // A remote transaction can land after the command event but before
        // this microtask. Render the merged Y.Doc immediately so the local
        // snapshot neither erases that update nor hides it in Univer.
        applyRemoteSnapshot();
      });
    });

    const disposePresence = collab?.awareness && collab.user
      ? attachSpreadsheetPresence({ api: univerAPI, awareness: collab.awareness, path, user: collab.user, onRemoteChange: setRemotePresence })
      : undefined;
    const selectionRefresh = univerAPI.addEvent(univerAPI.Event.SelectionChanged, () => {
      setOverlayTick((tick) => tick + 1);
      scheduleViewState();
    });
    const activeSheetRefresh = univerAPI.addEvent(univerAPI.Event.ActiveSheetChanged, () => {
      setOverlayTick((tick) => tick + 1);
      scheduleViewState();
    });
    return () => {
      if (viewStateFrame !== null) cancelAnimationFrame(viewStateFrame);
      onViewStateRef.current?.(workbookViewState(workbook));
      disposed = true;
      permissionGenerationRef.current += 1;
      disposePresence?.();
      selectionRefresh.dispose();
      activeSheetRefresh.dispose();
      commandListener.dispose();
      appearanceObserver.disconnect();
      if (renderAppearanceFrame !== null) cancelAnimationFrame(renderAppearanceFrame);
      renderCreatedSubscription.unsubscribe();
      doc.off("afterTransaction", onTransaction);
      apiRef.current = null;
      workbookRef.current = null;
      // Univer owns a nested React root inside the host. Disposing it during
      // this outer root's passive cleanup makes React 19 report a synchronous
      // nested-root unmount race. Let the outer commit finish first; the host
      // may be detached by then, but Univer can still release that root and its
      // canvas resources on the next task.
      setTimeout(() => univer.dispose(), 0);
    };
  }, [collab?.awareness, collab?.user, doc, i18n, interfaceLocale, path, setWorkbookPermission]);

  useLayoutEffect(() => {
    return registerAgentSpreadsheetDocument(path, {
      doc,
      canWrite: collab?.canWrite !== false,
      awareness: collab?.awareness,
      path,
      commit: async () => {
        flushRef.current();
        const collabCommit = collabCommitRef.current;
        if (collabCommit) {
          await collabCommit();
        } else if (!(await onPersistRef.current())) {
          throw new Error("Lattice could not persist the spreadsheet update.");
        }
      },
    }, active);
  }, [active, collab?.awareness, collab?.canWrite, doc, path]);

  useEffect(() => {
    if (collab?.doc || !localDoc) {
      flushRef.current = () => {};
      return;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    let idle: number | null = null;
    const usesIdleCallback = typeof window.requestIdleCallback === "function";
    const cancelScheduled = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (idle === null) return;
      if (usesIdleCallback) window.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
      idle = null;
    };
    const flush = () => {
      cancelScheduled();
      const content = spreadsheetDocContent(localDoc);
      localSourceRef.current = content;
      onChangeRef.current(content);
    };
    const flushWhenIdle = () => {
      idle = null;
      flush();
    };
    const onUpdate = () => {
      cancelScheduled();
      timer = setTimeout(() => {
        timer = null;
        // Canonical source generation still walks every row. Keep that work
        // out of active typing and scrolling while preserving explicit flushes.
        idle = usesIdleCallback
          ? window.requestIdleCallback(flushWhenIdle, { timeout: SERIALIZE_IDLE_TIMEOUT_MS })
          : window.setTimeout(flushWhenIdle, 0);
      }, SERIALIZE_DEBOUNCE_MS);
    };
    localDoc.on("update", onUpdate);
    flushRef.current = () => { if (timer !== null || idle !== null) flush(); };
    return () => {
      localDoc.off("update", onUpdate);
      if (timer !== null || idle !== null) flush();
      flushRef.current = () => {};
    };
  }, [collab?.doc, localDoc]);

  useLayoutEffect(() => {
    if (!onFlushPendingChange) return;
    const flush = () => { flushRef.current(); return true; };
    onFlushPendingChange(flush);
    return () => onFlushPendingChange(null);
  }, [onFlushPendingChange]);

  useEffect(() => {
    const api = apiRef.current;
    const workbook = api?.getActiveWorkbook();
    const activeSheet = workbook?.getActiveSheet();
    if (!api || !workbook || !activeSheet) return;
    const disposables: Array<{ dispose(): void }> = [];
    for (const entry of remotePresence) {
      if (entry.presence.sheetId !== activeSheet.getSheetId()) continue;
      const ranges = entry.presence.selections.flatMap((notation) => {
        try {
          const range = parseA1Range(notation);
          if (range.endRow >= activeSheet.getMaxRows() || range.endColumn >= activeSheet.getMaxColumns()) return [];
          return [activeSheet.getRange(
            range.startRow,
            range.startColumn,
            range.endRow - range.startRow + 1,
            range.endColumn - range.startColumn + 1,
          )];
        } catch {
          return [];
        }
      });
      if (ranges.length > 0) {
        disposables.push(activeSheet.highlightRanges(ranges, {
          stroke: entry.user.color,
          strokeWidth: 2,
          fill: `${entry.user.color}18`,
          widgets: {},
          widgetSize: 0,
        }));
      }
      const pointer = entry.presence.pointer;
      let markerRange = pointer && pointer.row < activeSheet.getMaxRows() && pointer.column < activeSheet.getMaxColumns()
        ? activeSheet.getRange(pointer.row, pointer.column)
        : ranges[0];
      if (!markerRange && entry.presence.activeCell) {
        try {
          const range = parseA1Range(entry.presence.activeCell);
          if (range.startRow < activeSheet.getMaxRows() && range.startColumn < activeSheet.getMaxColumns()) {
            markerRange = activeSheet.getRange(range.startRow, range.startColumn);
          }
        } catch { /* Ignore stale presence outside the current workbook. */ }
      }
      const popup = markerRange?.attachPopup({
        componentKey: SpreadsheetPresencePopup,
        direction: "top-left",
        hideOnInvisible: true,
        extraProps: {
          color: entry.user.color,
          name: entry.user.name,
        },
      });
      if (popup) disposables.push(popup);
    }
    return () => disposables.forEach((disposable) => disposable.dispose());
  }, [remotePresence, overlayTick]);

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
