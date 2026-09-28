import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType, ReactNode } from "react";
import { afterEach, describe, expect, it, vi, type Mock } from "vitest";
import type * as Y from "yjs";
import type { LatticeSpreadsheetFile, SpreadsheetCellData, SpreadsheetWorkbookData } from "./spreadsheet-types";

type CellValues = Record<string, Record<string, SpreadsheetCellData | null>>;
type MockCommand = { id: string; type: number; params?: { unitId?: string; subUnitId?: string; cellValue?: CellValues } };
type MockMenuItem = { id: string; title: string; tooltip?: string; icon?: string; action: () => void; order?: number };

const univerMock = vi.hoisted(() => ({
  uiPlugin: class MockUniverUIPlugin {},
  api: null as MockApi | null,
  workbooks: [] as MockWorkbook[],
  presetConfigs: [] as Array<Record<string, unknown>>,
  registeredPlugins: [] as Array<{ plugin: unknown; options: unknown }>,
  menuSchemas: [] as Array<Record<string, unknown>>,
  menus: [] as Array<{ item: MockMenuItem; path?: string }>,
  disposed: 0,
  theme: { current: { white: "#fff", black: "#000", gray: {} }, setTheme: vi.fn(), setDarkMode: vi.fn() },
}));
const tauriMock = vi.hoisted(() => ({ invoke: vi.fn(), save: vi.fn() }));
/** Each mounted editor's workbook document, by path, as the Agent tools see it. */
const sheetDocs = vi.hoisted(() => new Map<string, Y.Doc>());

type MockRange = ReturnType<typeof mockRange>;
type MockWorkbook = ReturnType<typeof makeWorkbook>;
type MockApi = ReturnType<typeof makeApi>;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mockRange(notation: string) {
  return {
    getA1Notation: () => notation,
    activate: vi.fn(),
    activateAsCurrentCell: vi.fn(),
  };
}

function makeSheet(snapshot: SpreadsheetWorkbookData, sheetId: string) {
  const sheet = () => snapshot.sheets[sheetId];
  const activeRange = mockRange("B2:C3");
  const activeCell = mockRange("B2");
  return {
    getSheetId: () => sheetId,
    getActiveRange: () => activeRange,
    getActiveCell: () => activeCell,
    getRange: (rowOrNotation: number | string, column?: number): MockRange =>
      mockRange(typeof rowOrNotation === "string" ? rowOrNotation : `${rowOrNotation}:${String(column)}`),
    getSheet: () => ({
      getCellRaw: (row: number, column: number) => sheet().cellData[row]?.[column] ?? null,
      getScrollLeftTopFromSnapshot: () => ({ scrollTop: sheet().scrollTop, scrollLeft: sheet().scrollLeft }),
    }),
    getZoom: () => sheet().zoomRatio,
    setDefaultStyle: vi.fn((style: Record<string, unknown>) => { sheet().defaultStyle = clone(style); }),
  };
}

function makeWorkbook(data: SpreadsheetWorkbookData) {
  const snapshot = clone(data);
  const sheets = new Map(snapshot.sheetOrder.map((sheetId) => [sheetId, makeSheet(snapshot, sheetId)]));
  const sheet = sheets.get(snapshot.sheetOrder[0])!;
  let activeSheet = sheet;
  const workbook = {
    data: snapshot,
    sheet,
    getId: () => snapshot.id,
    save: vi.fn(() => clone(snapshot)),
    getActiveSheet: () => activeSheet,
    getSheets: () => [...sheets.values()],
    getSheetBySheetId: (id: string) => sheets.get(id) ?? null,
    setActiveSheet: vi.fn((next: typeof sheet) => (activeSheet = next)),
  };
  univerMock.workbooks.push(workbook);
  return workbook;
}

function makeApi() {
  let active: MockWorkbook | null = null;
  const api = {
    Event: Object.fromEntries(["SelectionChanged", "CellPointerMove", "SheetEditStarted", "SheetEditEnded", "ActiveSheetChanged"].map((name) => [name, name])),
    commandListener: undefined as ((command: MockCommand) => void) | undefined,
    createWorkbook: (data: SpreadsheetWorkbookData) => (active = makeWorkbook(data)),
    disposeUnit: vi.fn(() => { active = null; }),
    onCommandExecuted: (listener: (command: MockCommand) => void) => {
      api.commandListener = listener;
      return { dispose: () => { if (api.commandListener === listener) api.commandListener = undefined; } };
    },
    addEvent: () => ({ dispose: vi.fn() }),
    syncExecuteCommand: vi.fn((_command: string, params: { subUnitId: string; cellValue: CellValues }) => {
      if (!active) return false;
      const cells = active.data.sheets[params.subUnitId].cellData;
      for (const [row, columns] of Object.entries(params.cellValue)) {
        for (const [column, value] of Object.entries(columns)) {
          if (value === null) delete cells[Number(row)]?.[Number(column)];
          else (cells[Number(row)] ??= {})[Number(column)] = clone(value);
        }
      }
      return true;
    }),
    getActiveWorkbook: () => active,
    createMenu: (item: MockMenuItem) => {
      const menu: { item: MockMenuItem; path?: string } = { item };
      univerMock.menus.push(menu);
      return { id: item.id, appendTo: (path: string) => { menu.path = path; } };
    },
  };
  univerMock.api = api;
  return api;
}

vi.mock("@univerjs/core", () => ({
  BorderStyleTypes: { THIN: 1 },
  CommandType: { COMMAND: 0, OPERATION: 1, MUTATION: 2 },
  DOCS_FORMULA_BAR_EDITOR_UNIT_ID_KEY: "UNIVER_FORMULA_BAR",
  IConfirmService: Symbol("IConfirmService"),
  LocaleType: { EN_US: "enUS", ZH_CN: "zhCN" },
  LogLevel: { WARN: 2 },
  ThemeService: class {},
  Univer: class {
    registerPlugin(plugin: unknown, options: unknown) {
      univerMock.registeredPlugins.push({ plugin, options });
    }
    dispose() { univerMock.disposed += 1; }
    __getInjector() {
      return {
        get: () => ({
          getCurrentTheme: () => univerMock.theme.current,
          setTheme: univerMock.theme.setTheme,
          setDarkMode: univerMock.theme.setDarkMode,
          getRenderById: () => null,
          created$: { subscribe: () => ({ unsubscribe: vi.fn() }) },
          mergeMenu: (schema: Record<string, unknown>) => { univerMock.menuSchemas.push(schema); },
        }),
      };
    }
  },
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMock.invoke }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: tauriMock.save }));
vi.mock("@univerjs/core/facade", () => ({ FUniver: { newAPI: () => makeApi() } }));
vi.mock("@univerjs/engine-render", () => ({
  IRenderManagerService: Symbol("IRenderManagerService"),
  SHEET_VIEWPORT_KEY: { VIEW_MAIN: "viewMain" },
}));
vi.mock("@univerjs/ui", () => ({
  IMenuManagerService: Symbol("IMenuManagerService"),
  MenuItemType: { BUTTON: 0, SELECTOR: 1 },
  UniverUIPlugin: univerMock.uiPlugin,
}));
vi.mock("@univerjs/preset-sheets-core", () => ({
  UniverSheetsCorePreset: (config: Record<string, unknown>) => {
    univerMock.presetConfigs.push(config);
    return { plugins: [[univerMock.uiPlugin, { container: config.container }]] };
  },
}));
vi.mock("@univerjs/preset-sheets-core/locales/en-US", () => ({ default: {} }));
vi.mock("@univerjs/preset-sheets-core/locales/zh-CN", () => ({ default: {} }));
vi.mock("../../agent/agent-spreadsheet-tools", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/agent-spreadsheet-tools")>();
  return {
    ...actual,
    registerAgentSpreadsheetDocument: (...args: Parameters<typeof actual.registerAgentSpreadsheetDocument>) => {
      sheetDocs.set(args[0], args[1].doc);
      return actual.registerAgentSpreadsheetDocument(...args);
    },
  };
});

import { SpreadsheetEditor, type SpreadsheetEditorProps } from "./spreadsheet-editor";
import { ConfirmActionProvider } from "../../components/ui/confirm-action-dialog";
import { activateAppLocale } from "../../i18n";
import { executeAgentSpreadsheetToolRequest, SYNARA_SPREADSHEET_TOOL_REQUEST } from "../../agent/agent-spreadsheet-tools";
import { applySpreadsheetBatch, readSpreadsheet } from "./spreadsheet-operations";
import { createDefaultSpreadsheet, serializeSpreadsheetFile } from "./spreadsheet-yjs";

afterEach(() => {
  // Unmount leftover editors before resetting Univer mocks. A thrown assertion
  // skips the rest of the test, and the next case would then talk to the
  // previous workbook's export menu / sheet ids.
  cleanup();
  univerMock.api = null;
  for (const list of [univerMock.workbooks, univerMock.presetConfigs, univerMock.registeredPlugins, univerMock.menuSchemas, univerMock.menus]) list.length = 0;
  univerMock.disposed = 0;
  univerMock.theme.setTheme.mockClear();
  univerMock.theme.setDarkMode.mockClear();
  tauriMock.invoke.mockReset();
  tauriMock.save.mockReset();
  sheetDocs.clear();
  for (const token of ["--editor-bg", "--text-primary", "--border-subtle", "--border-strong"]) document.documentElement.style.removeProperty(token);
  delete document.documentElement.dataset.theme;
});

function renderSheet(
  { file = createDefaultSpreadsheet("Sheet"), wrapper, ...props }: Partial<SpreadsheetEditorProps> & { file?: LatticeSpreadsheetFile; wrapper?: ComponentType<{ children: ReactNode }> } = {},
) {
  const onChange = vi.fn<(next: string) => void>();
  const view = render(
    <SpreadsheetEditor path="sheet.lattice-sheet" source={serializeSpreadsheetFile(file.workbook)} onChange={onChange} onPersist={async () => true} {...props} />,
    { wrapper },
  );
  return { view, onChange, workbook: univerMock.workbooks[0] };
}

/** A default workbook, with the document foreign (Agent) edits reach it through. */
function renderSeeded() {
  const rendered = renderSheet({ path: "seeded.lattice-sheet", source: "" });
  return { doc: sheetDocs.get("seeded.lattice-sheet")!, ...rendered };
}

function emitMutation(workbook: MockWorkbook, cellValue?: CellValues) {
  univerMock.api?.commandListener?.({
    id: "sheet.mutation.set-range-values",
    type: 2,
    params: { unitId: workbook.getId(), subUnitId: workbook.sheet.getSheetId(), cellValue },
  });
}

/** Run `emit` inside act and let the editor's microtask-scheduled reconcile settle. */
const settled = (emit: () => void) => act(async () => {
  emit();
  await Promise.resolve();
});
const dispatchMutation = (workbook: MockWorkbook, cellValue?: CellValues) => settled(() => emitMutation(workbook, cellValue));

async function savedWorkbook(onChange: Mock<(next: string) => void>): Promise<SpreadsheetWorkbookData> {
  await waitFor(() => expect(onChange).toHaveBeenCalled());
  return (JSON.parse(onChange.mock.calls.at(-1)?.[0] ?? "{}") as LatticeSpreadsheetFile).workbook;
}

const firstSheet = (workbook: SpreadsheetWorkbookData) => workbook.sheets[workbook.sheetOrder[0]];

describe("SpreadsheetEditor", () => {
  it("contains a malformed native file instead of crashing the workspace", () => {
    const { view } = renderSheet({ source: "{}" });
    expect(view.getByRole("alert")).toHaveTextContent("Couldn’t open this spreadsheet");
    expect(univerMock.workbooks).toHaveLength(0);
  });

  it("restores and reports per-user sheet navigation without changing the file", () => {
    const file = createDefaultSpreadsheet("Views");
    const firstSheetId = file.workbook.sheetOrder[0];
    const secondSheetId = "sheet-local-view";
    file.workbook.sheetOrder.push(secondSheetId);
    file.workbook.sheets[secondSheetId] = { ...clone(file.workbook.sheets[firstSheetId]), id: secondSheetId, name: "Analysis", cellData: {} };
    const views = {
      [firstSheetId]: { zoomRatio: 1.1, scrollTop: 20, scrollLeft: 10 },
      [secondSheetId]: { zoomRatio: 1.5, scrollTop: 240, scrollLeft: 80 },
    };
    const onViewState = vi.fn();
    const { view, workbook } = renderSheet({
      file,
      initialViewState: { activeSheetId: secondSheetId, activeRange: "D5:F8", activeCell: "D5", sheets: views },
      onViewState,
    });

    expect(workbook.data.sheets[firstSheetId]).toMatchObject(views[firstSheetId]);
    expect(workbook.data.sheets[secondSheetId]).toMatchObject(views[secondSheetId]);
    expect(workbook.setActiveSheet).toHaveBeenCalledWith(workbook.getSheetBySheetId(secondSheetId));
    view.unmount();
    expect(onViewState).toHaveBeenLastCalledWith(expect.objectContaining({
      activeSheetId: secondSheetId,
      sheets: expect.objectContaining({ [secondSheetId]: views[secondSheetId] }),
    }));
  });

  it("attaches a Lattice scrollbar to the All Functions list while it is open", async () => {
    const { view } = renderSheet();
    const host = view.container.querySelector<HTMLElement>(".spreadsheet-univer-host");
    const panel = document.createElement("div");
    panel.dataset.uComp = "sheets-formula-functions-panel";
    panel.innerHTML = '<div><ul class="univer-overflow-y-auto"></ul></div>';
    const list = panel.querySelector<HTMLElement>("ul");
    const scrollbar = () => view.container.querySelector(".spreadsheet-functions-scrollbar-surface .external-scrollbar");

    expect(host).not.toBeNull();
    act(() => host?.append(panel));
    await waitFor(() => expect(scrollbar()).not.toBeNull());
    await waitFor(() => {
      fireEvent.pointerEnter(list!);
      expect(scrollbar()).toHaveAttribute("data-hovering");
    });
    act(() => panel.remove());
    await waitFor(() => expect(view.container.querySelector(".spreadsheet-functions-scrollbar-surface")).not.toBeInTheDocument());
  });

  it("reconciles local Univer commands into the native file", async () => {
    const { view, onChange, workbook } = renderSheet();
    const sheet = firstSheet(workbook.data);
    sheet.name = "Renamed";
    sheet.cellData[0] = { 0: { f: "=2+2", s: { bl: 1, ff: "Times New Roman" } } };
    sheet.mergeData = [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 }];

    await dispatchMutation(workbook);
    const savedSheet = firstSheet(await savedWorkbook(onChange));
    expect(savedSheet).toMatchObject({
      name: "Renamed",
      cellData: { 0: { 0: { f: "=2+2", s: { bl: 1, ff: "Times New Roman" } } } },
      mergeData: [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 }],
    });
    expect(savedSheet).not.toHaveProperty("defaultStyle");
    view.unmount();
    // Univer's nested React root must unmount after the outer React commit.
    // Doing it synchronously here triggers React 19's nested-root race.
    await waitFor(() => expect(univerMock.disposed).toBe(1));
  });

  it("preserves workbook instance without rebuild when resizing column width locally", async () => {
    const { onChange, workbook } = renderSheet();
    firstSheet(workbook.data).columnData = { 5: { w: 240 } };

    await dispatchMutation(workbook);
    await savedWorkbook(onChange);
    expect(univerMock.workbooks).toHaveLength(1);
    expect(univerMock.api?.disposeUnit).not.toHaveBeenCalled();
  });

  it("does not reconcile view-only Univer commands into the native file", async () => {
    const { onChange, workbook } = renderSheet();
    await settled(() => univerMock.api?.commandListener?.({ id: "sheet.operation.set-scroll", type: 1, params: { unitId: workbook.getId() } }));
    expect(onChange).not.toHaveBeenCalled();
    expect(workbook.save).not.toHaveBeenCalled();
  });

  it("writes sparse cell mutations without saving the whole Univer workbook", async () => {
    const { doc, workbook } = renderSeeded();
    workbook.save.mockClear();
    workbook.data.sheets[workbook.sheet.getSheetId()].cellData[0] = { 0: { v: "fast", t: 1 } };

    await dispatchMutation(workbook, { 0: { 0: { v: "fast", t: 1 } } });
    expect(readSpreadsheet(doc, { range: "A1", include: ["values"] }).values).toEqual([["fast"]]);
    expect(workbook.save).not.toHaveBeenCalled();
  });

  it("exports the current workbook as a binary Excel file", async () => {
    await activateAppLocale("zh-CN");
    tauriMock.save.mockResolvedValue("/tmp/results.xlsx");
    tauriMock.invoke.mockResolvedValue("/tmp/results.xlsx");
    renderSheet({ path: "results.lattice-sheet" });

    const factory = expect.any(Function);
    expect(univerMock.menuSchemas).toContainEqual({ "ribbon.start.layout": { "lattice.spreadsheet.formulas": {
      order: -2,
      menuItemFactory: factory,
      "lattice.spreadsheet.formulas.all": { order: 0, menuItemFactory: factory },
    } } });
    const formulas = (univerMock.menuSchemas[0]["ribbon.start.layout"] as Record<string, unknown>)["lattice.spreadsheet.formulas"] as {
      menuItemFactory: () => unknown;
      "lattice.spreadsheet.formulas.all": { menuItemFactory: () => unknown };
    };
    expect(formulas.menuItemFactory()).toMatchObject({
      commandId: "formula-ui.operation.insert-function",
      title: "公式",
      tooltip: "插入公式",
      icon: "FunctionIcon",
      type: 1,
      selections: ["SUMIF", "SUM", "AVERAGE", "IF", "COUNT", "MAX", "MIN"].map((name) => ({ label: { name }, value: name })),
    });
    expect(formulas["lattice.spreadsheet.formulas.all"].menuItemFactory()).toMatchObject({ title: "所有函数…", type: 0 });
    const exportMenu = univerMock.menus.filter(({ item }) => item.id === "lattice.spreadsheet.export-xlsx").at(-1);
    expect(exportMenu).toMatchObject({
      item: { title: "导出 Excel", tooltip: "导出 Excel", icon: "ExportIcon", order: Number.MAX_SAFE_INTEGER },
      path: "ribbon.start.others",
    });
    act(() => exportMenu?.item.action());

    await waitFor(() => expect(tauriMock.invoke).toHaveBeenCalled());
    expect(tauriMock.save).toHaveBeenCalledWith(expect.objectContaining({
      title: "导出 Excel 工作簿",
      defaultPath: "results.xlsx",
      filters: [{ name: "Excel 工作簿", extensions: ["xlsx"] }],
    }));
    expect(tauriMock.invoke).toHaveBeenCalledWith(
      "save_xlsx",
      expect.any(ArrayBuffer),
      expect.objectContaining({ headers: { "x-xlsx-destination": expect.any(String) } }),
    );
  });

  it("uses visual colors without replacing the spreadsheet's default font", async () => {
    const setTokens = (tokens: Record<string, string>) => {
      for (const [name, value] of Object.entries(tokens)) document.documentElement.style.setProperty(name, value);
    };
    setTokens({ "--editor-bg": "#123456", "--text-primary": "#fedcba", "--border-subtle": "#345678", "--border-strong": "#456789" });
    const file = createDefaultSpreadsheet("Appearance");
    const sheet = firstSheet(file.workbook);
    sheet.defaultStyle = { bl: 1 };
    const { onChange, workbook } = renderSheet({ file });

    const displayedSheet = workbook.data.sheets[sheet.id];
    expect(displayedSheet.defaultStyle).toMatchObject({
      bl: 1,
      bg: { rgb: "#123456" },
      cl: { rgb: "#fedcba" },
      bd: { b: { s: 1, cl: { rgb: "#456789" } }, r: { s: 1, cl: { rgb: "#456789" } } },
    });
    expect(displayedSheet.defaultStyle).not.toHaveProperty("ff");
    expect(displayedSheet.defaultStyle).not.toHaveProperty("fs");
    expect(univerMock.theme.setTheme).toHaveBeenCalledWith(expect.objectContaining({ white: "#123456", black: "#fedcba" }));
    expect(univerMock.theme.setDarkMode).toHaveBeenCalledWith(false);
    expect(univerMock.presetConfigs[0]).toMatchObject({
      ribbonType: "simple",
      sheets: {
        scrollConfig: {
          barSize: 8,
          barBorder: 0,
          thumbMargin: 2,
          thumbBackgroundColor: "transparent",
          trackBackgroundColor: "transparent",
          trackBorderColor: "transparent",
        },
      },
      menu: Object.fromEntries([
        "sheet.command.add-range-protection-from-toolbar",
        "sheet.contextMenu.permission",
        "sheet.command.add-range-protection-from-sheet-bar",
        "formula-ui.operation.insert-function.common",
        "formula-ui.operation.insert-function.financial",
        "formula-ui.operation.insert-function.database",
        "sheet.toolbar.text-to-number",
      ].map((id) => [id, { hidden: true }])),
    });

    await act(async () => {
      setTokens({ "--editor-bg": "#1b1b1d", "--text-primary": "#e9e9e7" });
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });
    await waitFor(() => expect(univerMock.theme.setDarkMode).toHaveBeenLastCalledWith(true));
    expect(univerMock.theme.setTheme).toHaveBeenLastCalledWith(expect.objectContaining({
      white: "#1b1b1d",
      black: "#1b1b1d",
      gray: expect.objectContaining({ 200: "#456789", 300: "#345678" }),
    }));
    const darkEdge = { s: 1, cl: { rgb: "rgba(0, 0, 0, 0.12)" } };
    expect(displayedSheet.defaultStyle).toMatchObject({ bg: { rgb: "white" }, cl: { rgb: "gray.50" }, bd: { b: darkEdge, r: darkEdge } });

    displayedSheet.name = "Changed";
    await dispatchMutation(workbook);
    expect((await savedWorkbook(onChange)).sheets[sheet.id].defaultStyle).toEqual({ bl: 1 });
  });

  it.each([
    {
      locale: "en" as const,
      univer: { title: "Delete worksheet", children: "Confirm to delete this worksheet?", confirmText: "Confirm", cancelText: "Cancel" },
      dialog: "Delete worksheet?",
      description: "The worksheet and all of its contents will be removed",
      cancel: "Cancel",
      confirm: "Delete",
    },
    {
      locale: "zh-CN" as const,
      univer: { title: "删除工作表", children: "确认删除此工作表，删除后将不可找回，确定要删除吗？", confirmText: "确认", cancelText: "取消" },
      dialog: "要删除工作表吗？",
      description: "该工作表及其所有内容都将被删除，且无法恢复",
      cancel: "取消",
      confirm: "删除",
    },
  ])("routes $locale worksheet deletion through the Lattice destructive dialog", async ({ locale, univer, dialog, description, cancel, confirm }) => {
    await activateAppLocale(locale);
    renderSheet({ wrapper: ConfirmActionProvider });
    const uiRegistration = univerMock.registeredPlugins.find(({ plugin }) => plugin === univerMock.uiPlugin);
    const override = (uiRegistration?.options as {
      override: Array<[unknown, { useValue: { confirm(params: unknown): Promise<boolean> } }]>;
    }).override[0][1].useValue;

    let confirmation: Promise<boolean> | undefined;
    act(() => {
      confirmation = override.confirm({
        id: "sheet.confirm.remove-sheet",
        title: { title: univer.title },
        children: { title: univer.children },
        confirmText: univer.confirmText,
        cancelText: univer.cancelText,
      });
    });

    expect(await screen.findByRole("dialog", { name: dialog })).toHaveAccessibleDescription(description);
    expect(document.querySelector(".confirm-action-modal")).toHaveAttribute("data-destructive", "true");
    expect(screen.getByRole("button", { name: cancel })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: confirm }));
    await expect(confirmation).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("awaits a real local save before confirming an Agent update", async () => {
    const onPersist = vi.fn(async () => true);
    const { onChange } = renderSheet({ path: "agent.lattice-sheet", onPersist });

    const result = await executeAgentSpreadsheetToolRequest({
      type: SYNARA_SPREADSHEET_TOOL_REQUEST,
      version: 1,
      id: crypto.randomUUID(),
      action: "batch_update",
      args: { path: "agent.lattice-sheet", operations: [{ type: "set_values", range: "A1", values: [["Agent"]] }] },
      expiresAt: Date.now() + 10_000,
    });

    expect(onPersist).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, result: { persistenceConfirmed: true } });
    expect(firstSheet(await savedWorkbook(onChange)).cellData[0][0].v).toBe("Agent");
  });

  it("rebases a queued local command over a foreign update without losing either cell", async () => {
    const { doc, workbook } = renderSeeded();
    const sheet = firstSheet(workbook.data);
    sheet.cellData[0] = { 0: { v: "local", t: 1 } };

    await settled(() => {
      emitMutation(workbook, { 0: { 0: { v: "local", t: 1 } } });
      applySpreadsheetBatch(doc, { operations: [{ type: "set_values", range: "B1", values: [["remote"]] }] });
    });

    expect(readSpreadsheet(doc, { range: "A1:B1", include: ["values"] }).values).toEqual([["local", "remote"]]);
    expect(workbook.data.sheets[sheet.id].cellData[0]).toMatchObject({ 0: { v: "local" }, 1: { v: "remote" } });
  });

  it("patches foreign cells without echo and preserves view state across foreign structure changes", async () => {
    const { doc, workbook: initial } = renderSeeded();
    const localOrigins: unknown[] = [];
    doc.on("afterTransaction", (transaction) => {
      if (transaction.origin === "spreadsheet-local") localOrigins.push(transaction.origin);
    });
    Object.assign(firstSheet(initial.data), { scrollTop: 240, scrollLeft: 80, zoomRatio: 1.4 });
    const applyRemote = (operation: Parameters<typeof applySpreadsheetBatch>[1]["operations"][number]) =>
      settled(() => applySpreadsheetBatch(doc, { operations: [operation] }));

    await applyRemote({ type: "set_values", range: "A1", values: [[42]] });
    expect(univerMock.api?.syncExecuteCommand).toHaveBeenCalledWith(
      "sheet.mutation.set-range-values",
      expect.objectContaining({ cellValue: { 0: { 0: expect.objectContaining({ v: 42 }) } } }),
      { onlyLocal: true, fromCollab: true },
    );

    await applyRemote({ type: "rename_sheet", sheet: "Sheet1", name: "Remote" });
    expect(univerMock.workbooks).toHaveLength(2);
    const replacement = univerMock.workbooks[1];
    expect(firstSheet(replacement.data)).toMatchObject({ name: "Remote", scrollTop: 240, scrollLeft: 80, zoomRatio: 1.4 });
    expect(replacement.setActiveSheet).toHaveBeenCalled();
    expect(localOrigins).toEqual([]);
  });
});
