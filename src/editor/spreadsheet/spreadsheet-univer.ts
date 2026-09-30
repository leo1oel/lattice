import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import {
  BorderStyleTypes,
  ColorKit,
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
} from "@univerjs/core";
import { FUniver } from "@univerjs/core/facade";
import { UniverSheetsCorePreset } from "@univerjs/preset-sheets-core";
import enUS from "@univerjs/preset-sheets-core/locales/en-US";
import zhCN from "@univerjs/preset-sheets-core/locales/zh-CN";
import "@univerjs/preset-sheets-core/lib/index.css";
import { IRenderManagerService, SHEET_VIEWPORT_KEY, type IScrollBarProps } from "@univerjs/engine-render";
import { IMenuManagerService, MenuItemType, UniverUIPlugin, type IConfirmPartMethodOptions } from "@univerjs/ui";
import { BehaviorSubject } from "rxjs";
import { confirmAction, isRecord } from "../../app-utils";
import { clone, type SpreadsheetWorkbookData } from "./spreadsheet-types";

const FORMULAS_MENU_ID = "lattice.spreadsheet.formulas";
const EXPORT_MENU_ID = "lattice.spreadsheet.export-xlsx";
const FORMULA_SURFACE_LIGHT = "#FAFAFA";
const CHROME_SURFACE_LIGHT = "#F4F4F5";
const CHROME_SURFACE_DARK = "#18181A";
// eslint-disable-next-line lingui/no-unlocalized-strings -- spreadsheet function names are formula syntax
const COMMON_FORMULAS = ["SUMIF", "SUM", "AVERAGE", "IF", "COUNT", "MAX", "MIN"] as const;
const HIDDEN_MENU_ITEMS = [
  // Univer's protection rules are not part of Lattice's Yjs workbook schema
  // yet. Hiding every entry point prevents a local-only rule from looking like
  // a reliable permission boundary to the Agent.
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer menu ID
  "sheet.contextMenu.permission",
  ...["add-range-protection-from-toolbar", "add-range-protection-from-context-menu", "set-range-protection-from-context-menu",
    "delete-range-protection-from-context-menu", "view-sheet-permission-from-context-menu", "add-range-protection-from-sheet-bar",
    "delete-worksheet-protection-from-sheet-bar", "change-sheet-protection-from-sheet-bar", "view-sheet-permission-from-sheet-bar",
  ].map((command) => `sheet.command.${command}`),
  // The simple ribbon has no tab strip. A compact Formulas selector is added to
  // the Start group below; remove Univer's category duplicates and the lone
  // Data action from that single row.
  ...["common", "financial", "logical", "text", "date", "lookup", "math", "statistical", "engineering", "information", "database"]
    .map((category) => `formula-ui.operation.insert-function.${category}`),
  "sheet.toolbar.text-to-number",
];

export const SPREADSHEET_MESSAGES = {
  deleteWorksheetTitle: msg`Delete worksheet?`,
  deleteWorksheet: msg`The worksheet and all of its contents will be removed.`,
  deleteWorksheetPermanently: msg`The worksheet and all of its contents will be removed and cannot be recovered.`,
  continueTitle: msg`Continue?`,
  continueMessage: msg`Please confirm that you want to continue.`,
  delete: msg`Delete`,
  continue: msg`Continue`,
  cancel: msg`Cancel`,
  exportMenu: msg`Export Excel`,
  exportDialogTitle: msg`Export Excel workbook`,
  exportFileType: msg`Excel workbook`,
  formulasMenu: msg`Formulas`,
  formulasTooltip: msg`Insert a formula`,
  allFunctions: msg`All Functions…`,
};

type TranslateMessage = (message: MessageDescriptor) => string;
type UniverTheme = ReturnType<ThemeService["getCurrentTheme"]>;
type SpreadsheetLocale = "en" | "zh-CN";
type SpreadsheetAppearance = ReturnType<typeof spreadsheetAppearance>;

function confirmLabelText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(confirmLabelText).filter(Boolean).join(" ").trim() || undefined;
  if (!isRecord(value)) return undefined;
  for (const key of ["title", "value", "label", "children"] as const) {
    const text = confirmLabelText(value[key]);
    if (text) return text;
  }
  return isRecord(value.props) ? confirmLabelText(value.props.children) : undefined;
}

/** Routes Univer's confirmations through Lattice's dialog; worksheet removal gets localized destructive copy. */
class LatticeSpreadsheetConfirmService implements IConfirmService<IConfirmPartMethodOptions>, IDisposable {
  readonly confirmOptions$ = new BehaviorSubject<IConfirmPartMethodOptions[]>([]);
  private readonly openRequests = new Map<string, symbol>();

  constructor(private readonly translate: TranslateMessage, private readonly locale: SpreadsheetLocale) {}

  open(params: IConfirmPartMethodOptions): IDisposable {
    const request = Symbol(params.id);
    this.openRequests.set(params.id, request);
    void this.confirm(params).then((confirmed) => {
      if (this.openRequests.get(params.id) !== request) return;
      this.openRequests.delete(params.id);
      if (confirmed) params.onConfirm?.();
      else params.onClose?.();
    });
    return { dispose: () => { if (this.openRequests.get(params.id) === request) this.openRequests.delete(params.id); } };
  }

  confirm(params: IConfirmPartMethodOptions): Promise<boolean> {
    const t = this.translate;
    const title = confirmLabelText(params.title);
    const description = confirmLabelText(params.children);
    const cancelLabel = confirmLabelText(params.cancelText) ?? t(SPREADSHEET_MESSAGES.cancel);
    if (params.id === "sheet.confirm.remove-sheet") {
      // eslint-disable-next-line lingui/no-unlocalized-strings -- matches Univer's own locale copy to detect a permanent removal
      const permanent = description?.includes(this.locale === "zh-CN" ? "删除后将不可找回" : "not be retrieved after deletion");
      return confirmAction({
        title: t(SPREADSHEET_MESSAGES.deleteWorksheetTitle),
        message: t(permanent ? SPREADSHEET_MESSAGES.deleteWorksheetPermanently : SPREADSHEET_MESSAGES.deleteWorksheet),
        confirmLabel: t(SPREADSHEET_MESSAGES.delete),
        cancelLabel,
        destructive: true,
      });
    }
    return confirmAction({
      title: title ?? t(SPREADSHEET_MESSAGES.continueTitle),
      message: description ?? t(SPREADSHEET_MESSAGES.continueMessage),
      confirmLabel: confirmLabelText(params.confirmText) ?? t(SPREADSHEET_MESSAGES.continue),
      cancelLabel,
      destructive: /\b(delete|remove|discard|overwrite)\b/i.test(`${title ?? ""} ${description ?? ""}`),
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

// ── Appearance ───────────────────────────────────────────────────────────────

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

/** Read Lattice's design tokens so Univer's canvas matches the surrounding workspace. */
export function spreadsheetAppearance(container: HTMLElement) {
  const root = getComputedStyle(document.documentElement);
  const styles = getComputedStyle(container);
  const visible = (name: string, computed: string, fallback: string) => {
    const value = resolvedToken(root, name, computed);
    return value && value !== "rgba(0, 0, 0, 0)" && value !== "transparent" ? value : fallback;
  };
  return {
    background: visible("--editor-bg", styles.backgroundColor, "#f9f9fa"),
    foreground: visible("--text-primary", styles.color, "#242426"),
    surface: resolvedToken(root, "--surface-panel-raised", resolvedToken(root, "--panel-strong", "#f9f9fa")),
    border: visible("--border-subtle", styles.borderColor, "rgba(28, 28, 31, 0.09)"),
    gridline: visible("--border-strong", styles.borderColor, "rgba(28, 28, 31, 0.14)"),
    muted: visible("--text-tertiary", styles.outlineColor, "#6c6c72"),
    dark: document.documentElement.dataset.theme === "dark",
  };
}

export function applyUniverTheme(univer: Univer, baseTheme: UniverTheme, appearance: SpreadsheetAppearance): void {
  const { background, foreground, surface, border, gridline, muted, dark } = appearance;
  const themeService = univer.__getInjector().get(ThemeService);
  themeService.setTheme({
    ...baseTheme,
    // The worksheet defaults reference these theme slots so Univer does not
    // run its dark-mode color inversion over Lattice's already-dark colors.
    // Text utilities that reference `white` are corrected in the scoped host CSS.
    white: background,
    black: dark ? background : foreground,
    gray: {
      ...baseTheme.gray,
      // Dark: gray.200 is shared by grid lines and the canvas beyond the sheet,
      // so a translucent border keeps both subtle. Freeze handles use gray.300
      // at rest and gray.500 on hover; the subtle border keeps their native
      // enter/leave behavior without exposing the full-size drag targets.
      ...(dark
        ? { 50: foreground, 100: foreground, 200: gridline, 300: border, 400: muted, 500: muted, 600: border, 700: surface, 800: background, 900: background }
        : { 50: background, 100: surface, 200: border, 300: border, 400: muted, 500: muted, 600: foreground, 700: foreground, 800: foreground, 900: foreground }),
    },
  });
  themeService.setDarkMode(dark);
}

/** The display-only default cell style; the stored file keeps its own `defaultStyle`. */
export function appearanceDefaultStyle(workbook: SpreadsheetWorkbookData, sheetId: string, appearance: SpreadsheetAppearance): Record<string, unknown> {
  const defaultStyle = workbook.sheets[sheetId]?.defaultStyle;
  const existing = typeof defaultStyle === "string" ? workbook.styles[defaultStyle] : defaultStyle;
  // Univer inverts literal Canvas colors in dark mode. Supplying the inverse
  // neutral yields the same translucent light gridline token.
  const edge = () => ({ s: BorderStyleTypes.THIN, cl: { rgb: appearance.dark ? "rgba(0, 0, 0, 0.12)" : appearance.gridline } });
  return {
    bg: { rgb: appearance.dark ? "white" : appearance.background },
    cl: { rgb: appearance.dark ? "gray.50" : appearance.foreground },
    bd: { b: edge(), r: edge() },
    ...(isRecord(existing) ? clone(existing) : {}),
  };
}

export function withSpreadsheetAppearance(snapshot: SpreadsheetWorkbookData, appearance: SpreadsheetAppearance): SpreadsheetWorkbookData {
  const output = clone(snapshot);
  for (const sheetId of output.sheetOrder) output.sheets[sheetId].defaultStyle = appearanceDefaultStyle(snapshot, sheetId, appearance);
  return output;
}

function scrollConfig(appearance: SpreadsheetAppearance): IScrollBarProps {
  const thumb = appearance.dark ? "233, 233, 231" : "36, 36, 38";
  return {
    barSize: 8,
    barBorder: 0,
    thumbMargin: 2,
    thumbBackgroundColor: "transparent",
    thumbHoverBackgroundColor: `rgba(${thumb}, 0.12)`,
    thumbActiveBackgroundColor: `rgba(${thumb}, 0.16)`,
    trackBackgroundColor: "transparent",
    trackBorderColor: "transparent",
  };
}

type CanvasHeader = { setCustomHeader?(style: unknown): void; makeDirty(dirty: boolean): void };
type CanvasCorner = { setProps?(props: { fill: string; stroke: string }): { makeDirty(): unknown } };

function applyHeaderAppearance(renderManager: IRenderManagerService, unitId: string, appearance: SpreadsheetAppearance): boolean {
  const render = renderManager.getRenderById(unitId);
  if (!render) return false;
  const surface = appearance.dark ? CHROME_SURFACE_DARK : CHROME_SURFACE_LIGHT;
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer render component keys
  const headers = ["__SpreadsheetRowHeader__", "__SpreadsheetColumnHeader__"]
    .map((key) => render.components.get(key) as unknown as CanvasHeader | undefined);
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer render component key
  const corner = render.components.get("__SpreadsheetLeftTopPlaceholder__") as unknown as CanvasCorner | undefined;
  if (!corner?.setProps || !headers.every((header) => header?.setCustomHeader)) return false;
  for (const header of headers) {
    header!.setCustomHeader!({ headerStyle: { backgroundColor: surface, borderColor: appearance.border, fontColor: appearance.muted } });
    header!.makeDirty(true);
  }
  corner.setProps({ fill: surface, stroke: appearance.border }).makeDirty();
  render.scene.makeDirty();
  return true;
}

function applyScrollbarAppearance(renderManager: IRenderManagerService, unitId: string, appearance: SpreadsheetAppearance): boolean {
  const scrollbar = renderManager.getRenderById(unitId)?.scene.getViewport(SHEET_VIEWPORT_KEY.VIEW_MAIN)?.getScrollBar();
  if (!scrollbar) return false;
  const config = scrollConfig(appearance);
  scrollbar.setProps(config);
  for (const track of [scrollbar.horizonScrollTrack, scrollbar.verticalScrollTrack, scrollbar.placeholderBarRect]) {
    track?.setProps({ fill: config.trackBackgroundColor, stroke: config.trackBorderColor, strokeWidth: config.barBorder });
  }
  for (const thumb of [scrollbar.horizonThumbRect, scrollbar.verticalThumbRect]) thumb?.setProps({ fill: config.thumbBackgroundColor });
  scrollbar.makeDirty(true);
  return true;
}

function applyFormulaBarAppearance(renderManager: IRenderManagerService, appearance: SpreadsheetAppearance): boolean {
  const render = renderManager.getRenderById(DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY);
  if (!render) return false;
  const canvas = render.engine.getCanvas().getCanvasEle();
  // The render unit exists before FormulaBar registers its visible editor.
  // Waiting for the connected, sized canvas prevents that registration from
  // immediately replacing our background with Univer's hard-coded white.
  if (!canvas.isConnected || canvas.width === 0 || canvas.height === 0) return false;
  const background = appearance.dark ? appearance.background : FORMULA_SURFACE_LIGHT;
  canvas.style.backgroundColor = background;
  const { r, g, b } = new ColorKit(background).toRgb();
  const [red, green, blue] = appearance.dark ? invertColorByMatrix([r, g, b]) : [r, g, b];
  // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer render component key
  const docBackground = render.components.get("__Document_Render_Background__");
  if (docBackground && "setFillColors" in docBackground && typeof docBackground.setFillColors === "function") {
    // Univer's dark canvas color service inverts literal paint colors. Feed it
    // the inverse so the rendered bitmap still lands on Lattice's background.
    const fill = `rgb(${red}, ${green}, ${blue})`;
    docBackground.setFillColors(fill, fill, fill, fill);
  }
  render.scene.makeDirty();
  return true;
}

/** Paint header, scrollbar and formula-bar chrome; false until every render target exists. */
export function applyRenderAppearance(renderManager: IRenderManagerService, unitId: string, appearance: SpreadsheetAppearance): boolean {
  return [
    applyHeaderAppearance(renderManager, unitId, appearance),
    applyScrollbarAppearance(renderManager, unitId, appearance),
    applyFormulaBarAppearance(renderManager, appearance),
  ].every(Boolean);
}

export function createSpreadsheetUniver(
  container: HTMLElement,
  appearance: SpreadsheetAppearance,
  locale: SpreadsheetLocale,
  translate: TranslateMessage,
  onExportExcel: () => void,
): { univer: Univer; univerAPI: FUniver; baseTheme: UniverTheme; renderManager: IRenderManagerService } {
  const univer = new Univer({
    locale: locale === "zh-CN" ? LocaleType.ZH_CN : LocaleType.EN_US,
    locales: { [LocaleType.EN_US]: enUS, [LocaleType.ZH_CN]: zhCN },
    logLevel: LogLevel.WARN,
  });
  const injector = univer.__getInjector();
  const baseTheme = injector.get(ThemeService).getCurrentTheme();
  applyUniverTheme(univer, baseTheme, appearance);
  const preset = UniverSheetsCorePreset({
    container,
    header: true,
    toolbar: true,
    ribbonType: "simple",
    formulaBar: true,
    footer: {},
    menu: Object.fromEntries(HIDDEN_MENU_ITEMS.map((id) => [id, { hidden: true }])),
    sheets: { scrollConfig: scrollConfig(appearance) },
  });
  const confirmService = new LatticeSpreadsheetConfirmService(translate, locale);
  for (const entry of preset.plugins) {
    const [plugin, options] = Array.isArray(entry) ? entry : [entry, undefined] as [PluginCtor<Plugin>, undefined];
    univer.registerPlugin(plugin, plugin === UniverUIPlugin
      ? { ...options as ConstructorParameters<typeof UniverUIPlugin>[0], override: [[IConfirmService, { useValue: confirmService }]] }
      : options);
  }
  injector.get(IMenuManagerService).mergeMenu({
    "ribbon.start.layout": {
      [FORMULAS_MENU_ID]: {
        order: -2,
        menuItemFactory: () => ({
          id: FORMULAS_MENU_ID,
          commandId: "formula-ui.operation.insert-function",
          title: translate(SPREADSHEET_MESSAGES.formulasMenu),
          tooltip: translate(SPREADSHEET_MESSAGES.formulasTooltip),
          // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer icon name
          icon: "FunctionIcon",
          type: MenuItemType.SELECTOR,
          selections: COMMON_FORMULAS.map((formula) => ({ label: { name: formula, selectable: false }, value: formula })),
        }),
        [`${FORMULAS_MENU_ID}.all`]: {
          order: 0,
          menuItemFactory: () => ({ id: "formula-ui.operation.more-functions", title: translate(SPREADSHEET_MESSAGES.allFunctions), type: MenuItemType.BUTTON }),
        },
      },
    },
  });
  const univerAPI = FUniver.newAPI(univer);
  const exportLabel = translate(SPREADSHEET_MESSAGES.exportMenu);
  univerAPI.createMenu({
    id: EXPORT_MENU_ID,
    title: exportLabel,
    tooltip: exportLabel,
    // eslint-disable-next-line lingui/no-unlocalized-strings -- Univer icon name
    icon: "ExportIcon",
    action: onExportExcel,
    order: Number.MAX_SAFE_INTEGER,
  }).appendTo("ribbon.start.others");
  return { univer, univerAPI, baseTheme, renderManager: injector.get(IRenderManagerService) };
}
