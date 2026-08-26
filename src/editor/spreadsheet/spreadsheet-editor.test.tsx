import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentType } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";
import type {
  LatticeSpreadsheetFile,
  SpreadsheetCellData,
  SpreadsheetWorkbookData,
} from "./spreadsheet-types";

const univerMock = vi.hoisted(() => ({
  uiPlugin: class MockUniverUIPlugin {},
  api: null as MockApi | null,
  workbooks: [] as MockWorkbook[],
  presetConfigs: [] as Array<Record<string, unknown>>,
  registeredPlugins: [] as Array<{ plugin: unknown; options: unknown }>,
  menuSchemas: [] as Array<Record<string, unknown>>,
  menus: [] as Array<{
    item: { id: string; title: string; tooltip?: string; icon?: string; action: () => void; order?: number };
    path?: string;
  }>,
  disposed: 0,
  theme: {
    current: {
      white: "#fff",
      black: "#000",
      gray: {
        50: "#f9fafb",
        100: "#eeeff1",
        200: "#e3e5ea",
        300: "#a8b0bd",
        400: "#7d8698",
        500: "#4e5565",
        600: "#31363f",
        700: "#272a2f",
        800: "#1f2124",
        900: "#1b1c1f",
      },
    },
    setTheme: vi.fn(),
    setDarkMode: vi.fn(),
  },
}));
const tauriMock = vi.hoisted(() => ({
  invoke: vi.fn(),
  save: vi.fn(),
}));

type MockRange = {
  getA1Notation(): string;
  activate: ReturnType<typeof vi.fn>;
  activateAsCurrentCell: ReturnType<typeof vi.fn>;
  attachPopup: ReturnType<typeof vi.fn>;
};

type MockSheet = {
  getSheetId(): string;
  getActiveRange(): MockRange;
  getActiveCell(): MockRange;
  getRange(rowOrNotation: number | string, column?: number): MockRange;
  getSheet(): {
    getCellRaw(row: number, column: number): SpreadsheetCellData | null;
    getScrollLeftTopFromSnapshot(): { scrollTop: number; scrollLeft: number };
  };
  getZoom(): number;
  getMaxRows(): number;
  getMaxColumns(): number;
  highlightRanges: ReturnType<typeof vi.fn>;
  setDefaultStyle: ReturnType<typeof vi.fn>;
};

type MockWorkbook = {
  data: SpreadsheetWorkbookData;
  permission: { setEditable: ReturnType<typeof vi.fn>; setReadOnly: ReturnType<typeof vi.fn> };
  sheet: MockSheet;
  getId(): string;
  save: ReturnType<typeof vi.fn>;
  getWorkbookPermission(): MockWorkbook["permission"];
  getActiveSheet(): MockSheet;
  getSheets(): MockSheet[];
  getSheetBySheetId(id: string): MockSheet | null;
  setActiveSheet: ReturnType<typeof vi.fn>;
};

type MockSetRangeValuesParams = {
  subUnitId: string;
  cellValue: Record<string, Record<string, SpreadsheetCellData | null>>;
};

type MockCommandInfo = {
  id: string;
  type: number;
  params?: {
    unitId?: string;
    subUnitId?: string;
    cellValue?: Record<string, Record<string, SpreadsheetCellData | null>>;
  };
};

type MockApi = {
  Event: Record<string, string>;
  commandListener?: (command: MockCommandInfo) => void;
  events: Map<string, Set<() => void>>;
  createWorkbook(data: SpreadsheetWorkbookData): MockWorkbook;
  disposeUnit: ReturnType<typeof vi.fn>;
  onCommandExecuted(listener: (command: MockCommandInfo) => void): { dispose(): void };
  addEvent(event: string, listener: () => void): { dispose(): void };
  executeCommand: ReturnType<typeof vi.fn>;
  syncExecuteCommand: ReturnType<typeof vi.fn>;
  getActiveWorkbook(): MockWorkbook | null;
  createMenu(item: {
    id: string;
    title: string;
    tooltip?: string;
    icon?: string;
    action: () => void;
    order?: number;
  }): { id: string; appendTo(path: string): void };
};

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function mockRange(notation: string): MockRange {
  return {
    getA1Notation: () => notation,
    activate: vi.fn(),
    activateAsCurrentCell: vi.fn(),
    attachPopup: vi.fn(() => ({ dispose: vi.fn() })),
  };
}

function makeWorkbook(data: SpreadsheetWorkbookData): MockWorkbook {
  const snapshot = clone(data);
  const sheets = new Map(snapshot.sheetOrder.map((sheetId) => {
    const activeRange = mockRange("B2:C3");
    const activeCell = mockRange("B2");
    const sheet: MockSheet = {
      getSheetId: () => sheetId,
      getActiveRange: () => activeRange,
      getActiveCell: () => activeCell,
      getRange: (rowOrNotation, column) => mockRange(
        typeof rowOrNotation === "string" ? rowOrNotation : `${rowOrNotation}:${String(column)}`,
      ),
      getSheet: () => ({
        getCellRaw: (row, column) => snapshot.sheets[sheetId].cellData[row]?.[column] ?? null,
        getScrollLeftTopFromSnapshot: () => ({
          scrollTop: snapshot.sheets[sheetId].scrollTop,
          scrollLeft: snapshot.sheets[sheetId].scrollLeft,
        }),
      }),
      getZoom: () => snapshot.sheets[sheetId].zoomRatio,
      getMaxRows: () => snapshot.sheets[sheetId].rowCount,
      getMaxColumns: () => snapshot.sheets[sheetId].columnCount,
      highlightRanges: vi.fn(() => ({ dispose: vi.fn() })),
      setDefaultStyle: vi.fn((style: Record<string, unknown>) => {
        snapshot.sheets[sheetId].defaultStyle = clone(style);
      }),
    };
    return [sheetId, sheet] as const;
  }));
  const sheet = sheets.get(snapshot.sheetOrder[0])!;
  let activeSheet = sheet;
  const permission = { setEditable: vi.fn(async () => undefined), setReadOnly: vi.fn(async () => undefined) };
  const workbook: MockWorkbook = {
    data: snapshot,
    permission,
    sheet,
    getId: () => snapshot.id,
    save: vi.fn(() => clone(snapshot)),
    getWorkbookPermission: () => permission,
    getActiveSheet: () => activeSheet,
    getSheets: () => [...sheets.values()],
    getSheetBySheetId: (id) => sheets.get(id) ?? null,
    setActiveSheet: vi.fn((next: MockSheet) => {
      activeSheet = next;
      return next;
    }),
  };
  univerMock.workbooks.push(workbook);
  return workbook;
}

function makeApi(): MockApi {
  let active: MockWorkbook | null = null;
  const api: MockApi = {
    Event: {
      SelectionChanged: "SelectionChanged",
      CellPointerMove: "CellPointerMove",
      SheetEditStarted: "SheetEditStarted",
      SheetEditEnded: "SheetEditEnded",
      ActiveSheetChanged: "ActiveSheetChanged",
    },
    events: new Map(),
    createWorkbook: (data) => (active = makeWorkbook(data)),
    disposeUnit: vi.fn(() => { active = null; }),
    onCommandExecuted: (listener) => {
      api.commandListener = listener;
      return { dispose: () => { if (api.commandListener === listener) api.commandListener = undefined; } };
    },
    addEvent: (event, listener) => {
      const listeners = api.events.get(event) ?? new Set();
      listeners.add(listener);
      api.events.set(event, listeners);
      return { dispose: () => listeners.delete(listener) };
    },
    executeCommand: vi.fn(async () => true),
    syncExecuteCommand: vi.fn((_command, params: MockSetRangeValuesParams) => {
      if (!active) return false;
      const cells = active.data.sheets[params.subUnitId].cellData;
      for (const [row, columns] of Object.entries(params.cellValue)) {
        for (const [column, value] of Object.entries(columns)) {
          const rowIndex = Number(row);
          const columnIndex = Number(column);
          if (value === null) delete cells[rowIndex]?.[columnIndex];
          else (cells[rowIndex] ??= {})[columnIndex] = clone(value);
        }
      }
      return true;
    }),
    getActiveWorkbook: () => active,
    createMenu: (item) => {
      const menu: (typeof univerMock.menus)[number] = { item };
      univerMock.menus.push(menu);
      return { id: item.id, appendTo: (path) => { menu.path = path; } };
    },
  };
  univerMock.api = api;
  return api;
}

function dispatchWorkbookMutation(
  workbook: MockWorkbook,
  cellValue?: Record<string, Record<string, SpreadsheetCellData | null>>,
): void {
  univerMock.api?.commandListener?.({
    id: "sheet.mutation.set-range-values",
    type: 2,
    params: {
      unitId: workbook.getId(),
      subUnitId: workbook.sheet.getSheetId(),
      cellValue,
    },
  });
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

vi.mock("@univerjs/core/facade", () => ({
  FUniver: { newAPI: () => makeApi() },
}));

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

import { SpreadsheetEditor } from "./spreadsheet-editor";
import { ConfirmActionProvider } from "../../components/ui/confirm-action-dialog";
import { activateAppLocale } from "../../i18n";
import {
  executeAgentSpreadsheetToolRequest,
  SYNARA_SPREADSHEET_TOOL_REQUEST,
} from "../../agent/agent-spreadsheet-tools";
import { applySpreadsheetBatch, readSpreadsheet } from "./spreadsheet-operations";
import { createDefaultSpreadsheet, seedSpreadsheetDoc, serializeSpreadsheetFile } from "./spreadsheet-yjs";

afterEach(() => {
  // Unmount leftover editors before resetting Univer mocks. A thrown assertion
  // skips the per-test `view.unmount()`, and the next case then talks to the
  // previous workbook's export menu / sheet ids.
  cleanup();
  univerMock.api = null;
  univerMock.workbooks.length = 0;
  univerMock.presetConfigs.length = 0;
  univerMock.registeredPlugins.length = 0;
  univerMock.menuSchemas.length = 0;
  univerMock.menus.length = 0;
  univerMock.disposed = 0;
  univerMock.theme.setTheme.mockClear();
  univerMock.theme.setDarkMode.mockClear();
  tauriMock.invoke.mockReset();
  tauriMock.save.mockReset();
  for (const token of [
    "--editor-font",
    "--editor-font-size",
    "--editor-bg",
    "--text-primary",
    "--border-subtle",
    "--border-strong",
  ]) {
    document.documentElement.style.removeProperty(token);
  }
  delete document.documentElement.dataset.theme;
});

describe("SpreadsheetEditor collaboration bridge", () => {
  it("contains a malformed native file instead of crashing the workspace", () => {
    const view = render(
      <SpreadsheetEditor
        path="broken.lattice-sheet"
        source="{}"
        onChange={vi.fn()}
        onPersist={async () => true}
      />,
    );

    expect(view.getByRole("alert")).toHaveTextContent("Couldn’t open this spreadsheet");
    expect(univerMock.workbooks).toHaveLength(0);
    view.unmount();
  });

  it("restores and reports per-user sheet navigation without changing the file", () => {
    const file = createDefaultSpreadsheet("Views");
    const firstSheetId = file.workbook.sheetOrder[0];
    const secondSheetId = "sheet-local-view";
    file.workbook.sheetOrder.push(secondSheetId);
    file.workbook.sheets[secondSheetId] = {
      ...clone(file.workbook.sheets[firstSheetId]),
      id: secondSheetId,
      name: "Analysis",
      cellData: {},
    };
    const onViewState = vi.fn();
    const view = render(
      <SpreadsheetEditor
        path="views.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={vi.fn()}
        onPersist={async () => true}
        initialViewState={{
          activeSheetId: secondSheetId,
          activeRange: "D5:F8",
          activeCell: "D5",
          sheets: {
            [firstSheetId]: { zoomRatio: 1.1, scrollTop: 20, scrollLeft: 10 },
            [secondSheetId]: { zoomRatio: 1.5, scrollTop: 240, scrollLeft: 80 },
          },
        }}
        onViewState={onViewState}
      />,
    );

    const workbook = univerMock.workbooks[0];
    expect(workbook.data.sheets[firstSheetId]).toMatchObject({
      zoomRatio: 1.1,
      scrollTop: 20,
      scrollLeft: 10,
    });
    expect(workbook.data.sheets[secondSheetId]).toMatchObject({
      zoomRatio: 1.5,
      scrollTop: 240,
      scrollLeft: 80,
    });
    const secondSheet = workbook.getSheetBySheetId(secondSheetId);
    expect(workbook.setActiveSheet).toHaveBeenCalledWith(secondSheet);
    view.unmount();
    expect(onViewState).toHaveBeenLastCalledWith(expect.objectContaining({
      activeSheetId: secondSheetId,
      sheets: expect.objectContaining({
        [secondSheetId]: { zoomRatio: 1.5, scrollTop: 240, scrollLeft: 80 },
      }),
    }));
  });

  it("attaches a Lattice scrollbar to the All Functions list while it is open", async () => {
    const file = createDefaultSpreadsheet("Functions");
    const view = render(
      <SpreadsheetEditor
        path="functions.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={vi.fn()}
        onPersist={async () => true}
      />,
    );
    const host = view.container.querySelector<HTMLElement>(".spreadsheet-univer-host");
    const panel = document.createElement("div");
    panel.dataset.uComp = "sheets-formula-functions-panel";
    panel.innerHTML = '<div><ul class="univer-overflow-y-auto"></ul></div>';
    const list = panel.querySelector<HTMLElement>("ul");

    expect(host).not.toBeNull();
    expect(list).not.toBeNull();
    act(() => host?.append(panel));
    await waitFor(() => {
      expect(view.container.querySelector(
        ".spreadsheet-functions-scrollbar-surface .external-scrollbar",
      )).not.toBeNull();
    });
    await waitFor(() => {
      fireEvent.pointerEnter(list as HTMLElement);
      expect(
        view.container.querySelector(".spreadsheet-functions-scrollbar-surface .external-scrollbar"),
      ).toHaveAttribute("data-hovering");
    });

    act(() => panel.remove());
    await waitFor(() => {
      expect(view.container.querySelector(".spreadsheet-functions-scrollbar-surface"))
        .not.toBeInTheDocument();
    });
    view.unmount();
  });

  it("reconciles local Univer commands into the native file", async () => {
    const file = createDefaultSpreadsheet("Local");
    const onChange = vi.fn();
    const view = render(
      <SpreadsheetEditor
        path="data.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={onChange}
        onPersist={async () => true}
      />,
    );
    const workbook = univerMock.workbooks[0];
    const sheet = workbook.data.sheets[workbook.data.sheetOrder[0]];
    sheet.name = "Renamed";
    sheet.cellData[0] = { 0: { f: "=2+2", s: { bl: 1, ff: "Times New Roman" } } };
    sheet.mergeData = [{ startRow: 1, startColumn: 0, endRow: 1, endColumn: 1 }];

    await act(async () => {
      dispatchWorkbookMutation(workbook);
      await Promise.resolve();
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = JSON.parse(onChange.mock.calls.at(-1)?.[0] ?? "{}") as LatticeSpreadsheetFile;
    const savedSheet = saved.workbook.sheets[saved.workbook.sheetOrder[0]];
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
    const file = createDefaultSpreadsheet("Resize");
    const onChange = vi.fn();
    const view = render(
      <SpreadsheetEditor
        path="resize.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={onChange}
        onPersist={async () => true}
      />,
    );
    const initialWorkbookCount = univerMock.workbooks.length;
    const workbook = univerMock.workbooks[0];
    const sheet = workbook.data.sheets[workbook.data.sheetOrder[0]];
    sheet.columnData = { 5: { w: 240 } };

    await act(async () => {
      dispatchWorkbookMutation(workbook);
      await Promise.resolve();
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    expect(univerMock.workbooks.length).toBe(initialWorkbookCount);
    expect(univerMock.api?.disposeUnit).not.toHaveBeenCalled();
    view.unmount();
  });

  it("does not reconcile view-only Univer commands into the native file", async () => {
    const file = createDefaultSpreadsheet("Scroll");
    const onChange = vi.fn();
    const view = render(
      <SpreadsheetEditor
        path="scroll.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={onChange}
        onPersist={async () => true}
      />,
    );
    const workbook = univerMock.workbooks[0];

    await act(async () => {
      univerMock.api?.commandListener?.({
        id: "sheet.operation.set-scroll",
        type: 1,
        params: { unitId: workbook.getId() },
      });
      await Promise.resolve();
    });

    expect(onChange).not.toHaveBeenCalled();
    expect(workbook.save).not.toHaveBeenCalled();
    view.unmount();
  });

  it("writes sparse cell mutations without saving the whole Univer workbook", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const view = render(
      <SpreadsheetEditor
        path="large.lattice-sheet"
        source=""
        onChange={vi.fn()}
        onPersist={async () => true}
        collab={{ doc, awareness: null, user: null, canWrite: true }}
      />,
    );
    const workbook = univerMock.workbooks[0];
    workbook.save.mockClear();
    workbook.data.sheets[workbook.sheet.getSheetId()].cellData[0] = { 0: { v: "fast", t: 1 } };

    await act(async () => {
      dispatchWorkbookMutation(workbook, { 0: { 0: { v: "fast", t: 1 } } });
      await Promise.resolve();
    });

    expect(readSpreadsheet(doc, { range: "A1", include: ["values"] }).values).toEqual([["fast"]]);
    expect(workbook.save).not.toHaveBeenCalled();
    view.unmount();
    doc.destroy();
  });

  it("exports the current workbook as a binary Excel file", async () => {
    await activateAppLocale("zh-CN");
    tauriMock.save.mockResolvedValue("/tmp/results.xlsx");
    tauriMock.invoke.mockResolvedValue("/tmp/results.xlsx");
    const file = createDefaultSpreadsheet("Results");
    const view = render(
      <SpreadsheetEditor
        path="results.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={vi.fn()}
        onPersist={async () => true}
      />,
    );

    const exportMenu = univerMock.menus.filter(
      ({ item }) => item.id === "lattice.spreadsheet.export-xlsx",
    ).at(-1);
    expect(univerMock.menuSchemas).toContainEqual({
      "ribbon.start.layout": {
        "lattice.spreadsheet.formulas": {
          order: -2,
          menuItemFactory: expect.any(Function),
          "lattice.spreadsheet.formulas.all": {
            order: 0,
            menuItemFactory: expect.any(Function),
          },
        },
      },
    });
    const toolbarSchema = univerMock.menuSchemas[0]["ribbon.start.layout"] as Record<string, unknown>;
    const formulasSchema = toolbarSchema["lattice.spreadsheet.formulas"] as {
      menuItemFactory: () => unknown;
      "lattice.spreadsheet.formulas.all": { menuItemFactory: () => unknown };
    };
    expect(formulasSchema.menuItemFactory()).toMatchObject({
      commandId: "formula-ui.operation.insert-function",
      title: "公式",
      tooltip: "插入公式",
      icon: "FunctionIcon",
      type: 1,
      selections: [
        { label: { name: "SUMIF" }, value: "SUMIF" },
        { label: { name: "SUM" }, value: "SUM" },
        { label: { name: "AVERAGE" }, value: "AVERAGE" },
        { label: { name: "IF" }, value: "IF" },
        { label: { name: "COUNT" }, value: "COUNT" },
        { label: { name: "MAX" }, value: "MAX" },
        { label: { name: "MIN" }, value: "MIN" },
      ],
    });
    expect(formulasSchema["lattice.spreadsheet.formulas.all"].menuItemFactory()).toMatchObject({
      title: "所有函数…",
      type: 0,
    });
    expect(exportMenu).toMatchObject({
      item: {
        title: "导出 Excel",
        tooltip: "导出 Excel",
        icon: "ExportIcon",
        order: Number.MAX_SAFE_INTEGER,
      },
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
    view.unmount();
  });

  it("uses visual colors without replacing the spreadsheet's default font", async () => {
    document.documentElement.style.setProperty("--editor-bg", "#123456");
    document.documentElement.style.setProperty("--text-primary", "#fedcba");
    document.documentElement.style.setProperty("--border-subtle", "#345678");
    document.documentElement.style.setProperty("--border-strong", "#456789");
    const file = createDefaultSpreadsheet("Appearance");
    const sheet = file.workbook.sheets[file.workbook.sheetOrder[0]];
    sheet.defaultStyle = { bl: 1 };
    const onChange = vi.fn();
    const view = render(
      <SpreadsheetEditor
        path="appearance.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={onChange}
        onPersist={async () => true}
      />,
    );

    const displayedSheet = univerMock.workbooks[univerMock.workbooks.length - 1].data.sheets[sheet.id];
    expect(displayedSheet.defaultStyle).toMatchObject({
      bl: 1,
      bg: { rgb: "#123456" },
      cl: { rgb: "#fedcba" },
      bd: {
        b: { s: 1, cl: { rgb: "#456789" } },
        r: { s: 1, cl: { rgb: "#456789" } },
      },
    });
    expect(displayedSheet.defaultStyle).not.toHaveProperty("ff");
    expect(displayedSheet.defaultStyle).not.toHaveProperty("fs");
    expect(univerMock.theme.setTheme).toHaveBeenCalledWith(expect.objectContaining({
      white: "#123456",
      black: "#fedcba",
    }));
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
      menu: {
        "sheet.command.add-range-protection-from-toolbar": { hidden: true },
        "sheet.contextMenu.permission": { hidden: true },
        "sheet.command.add-range-protection-from-sheet-bar": { hidden: true },
        "formula-ui.operation.insert-function.common": { hidden: true },
        "formula-ui.operation.insert-function.financial": { hidden: true },
        "formula-ui.operation.insert-function.database": { hidden: true },
        "sheet.toolbar.text-to-number": { hidden: true },
      },
    });

    await act(async () => {
      document.documentElement.style.setProperty("--editor-bg", "#1b1b1d");
      document.documentElement.style.setProperty("--text-primary", "#e9e9e7");
      document.documentElement.dataset.theme = "dark";
      await Promise.resolve();
    });
    await waitFor(() => expect(univerMock.theme.setDarkMode).toHaveBeenLastCalledWith(true));
    expect(univerMock.theme.setTheme).toHaveBeenLastCalledWith(expect.objectContaining({
      white: "#1b1b1d",
      black: "#1b1b1d",
      gray: expect.objectContaining({ 200: "#456789", 300: "#345678" }),
    }));
    expect(displayedSheet.defaultStyle).toMatchObject({
      bg: { rgb: "white" },
      cl: { rgb: "gray.50" },
      bd: {
        b: { s: 1, cl: { rgb: "rgba(0, 0, 0, 0.12)" } },
        r: { s: 1, cl: { rgb: "rgba(0, 0, 0, 0.12)" } },
      },
    });

    displayedSheet.name = "Changed";
    await act(async () => {
      dispatchWorkbookMutation(univerMock.workbooks[univerMock.workbooks.length - 1]);
      await Promise.resolve();
    });
    await waitFor(() => expect(onChange).toHaveBeenCalled());
    const saved = JSON.parse(onChange.mock.calls.at(-1)?.[0] ?? "{}") as LatticeSpreadsheetFile;
    expect(saved.workbook.sheets[sheet.id].defaultStyle).toEqual({ bl: 1 });
    view.unmount();
  });

  it("routes worksheet deletion through the Lattice destructive dialog", async () => {
    const file = createDefaultSpreadsheet("Delete dialog");
    const view = render(
      <ConfirmActionProvider>
        <SpreadsheetEditor
          path="delete-dialog.lattice-sheet"
          source={serializeSpreadsheetFile(file.workbook)}
          onChange={vi.fn()}
          onPersist={async () => true}
        />
      </ConfirmActionProvider>,
    );
    const uiRegistration = univerMock.registeredPlugins.find(({ plugin }) => plugin === univerMock.uiPlugin);
    const override = (uiRegistration?.options as {
      override: Array<[unknown, { useValue: { confirm(params: unknown): Promise<boolean> } }]>;
    }).override[0][1].useValue;

    let confirmation: Promise<boolean> | undefined;
    act(() => {
      confirmation = override.confirm({
        id: "sheet.confirm.remove-sheet",
        title: { title: "Delete worksheet" },
        children: { title: "Confirm to delete this worksheet?" },
        confirmText: "Confirm",
        cancelText: "Cancel",
      });
    });

    const dialog = await screen.findByRole("dialog", { name: "Delete worksheet?" });
    expect(dialog).toHaveAccessibleDescription("The worksheet and all of its contents will be removed");
    expect(document.querySelector(".confirm-action-modal")).toHaveAttribute("data-destructive", "true");
    expect(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    await expect(confirmation).resolves.toBe(true);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    view.unmount();
  });

  it("localizes the worksheet deletion dialog to the interface language", async () => {
    await activateAppLocale("zh-CN");
    const file = createDefaultSpreadsheet("删除弹窗");
    const view = render(
      <ConfirmActionProvider>
        <SpreadsheetEditor
          path="delete-dialog-zh.lattice-sheet"
          source={serializeSpreadsheetFile(file.workbook)}
          onChange={vi.fn()}
          onPersist={async () => true}
        />
      </ConfirmActionProvider>,
    );
    const uiRegistration = univerMock.registeredPlugins.find(({ plugin }) => plugin === univerMock.uiPlugin);
    const override = (uiRegistration?.options as {
      override: Array<[unknown, { useValue: { confirm(params: unknown): Promise<boolean> } }]>;
    }).override[0][1].useValue;

    let confirmation: Promise<boolean> | undefined;
    act(() => {
      confirmation = override.confirm({
        id: "sheet.confirm.remove-sheet",
        title: { title: "删除工作表" },
        children: { title: "确认删除此工作表，删除后将不可找回，确定要删除吗？" },
        confirmText: "确认",
        cancelText: "取消",
      });
    });

    const dialog = await screen.findByRole("dialog", { name: "要删除工作表吗？" });
    expect(dialog).toHaveAccessibleDescription("该工作表及其所有内容都将被删除，且无法恢复");
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "删除" }));
    await expect(confirmation).resolves.toBe(true);
    view.unmount();
  });

  it("awaits a real local save before confirming an Agent update", async () => {
    const file = createDefaultSpreadsheet("Local Agent");
    const onChange = vi.fn();
    const onPersist = vi.fn(async () => true);
    const view = render(
      <SpreadsheetEditor
        path="agent.lattice-sheet"
        source={serializeSpreadsheetFile(file.workbook)}
        onChange={onChange}
        onPersist={onPersist}
      />,
    );

    const result = await executeAgentSpreadsheetToolRequest({
      type: SYNARA_SPREADSHEET_TOOL_REQUEST,
      version: 1,
      id: crypto.randomUUID(),
      action: "batch_update",
      args: {
        path: "agent.lattice-sheet",
        operations: [{ type: "set_values", range: "A1", values: [["Agent"]] }],
      },
      expiresAt: Date.now() + 10_000,
    });

    expect(onPersist).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ ok: true, result: { persistenceConfirmed: true } });
    const saved = JSON.parse(onChange.mock.calls.at(-1)?.[0] ?? "{}") as LatticeSpreadsheetFile;
    expect(saved.workbook.sheets[saved.workbook.sheetOrder[0]].cellData[0][0].v).toBe("Agent");
    view.unmount();
  });

  it("rebases a queued local command over a remote update without losing either cell", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const view = render(
      <SpreadsheetEditor
        path="shared.lattice-sheet"
        source=""
        onChange={vi.fn()}
        onPersist={async () => true}
        collab={{ doc, awareness: null, user: null, canWrite: true }}
      />,
    );
    const workbook = univerMock.workbooks[0];
    const sheet = workbook.data.sheets[workbook.data.sheetOrder[0]];
    sheet.cellData[0] = { 0: { v: "local", t: 1 } };

    await act(async () => {
      dispatchWorkbookMutation(workbook, { 0: { 0: { v: "local", t: 1 } } });
      applySpreadsheetBatch(doc, {
        operations: [{ type: "set_values", range: "B1", values: [["remote"]] }],
      });
      await Promise.resolve();
    });

    expect(readSpreadsheet(doc, { range: "A1:B1", include: ["values"] }).values)
      .toEqual([["local", "remote"]]);
    expect(workbook.data.sheets[sheet.id].cellData[0]).toMatchObject({
      0: { v: "local" },
      1: { v: "remote" },
    });
    view.unmount();
    doc.destroy();
  });

  it("patches remote cells without echo and preserves view state across remote structure changes", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const localOrigins: unknown[] = [];
    doc.on("afterTransaction", (transaction) => {
      if (transaction.origin === "spreadsheet-local") localOrigins.push(transaction.origin);
    });
    const view = render(
      <SpreadsheetEditor
        path="shared.lattice-sheet"
        source=""
        onChange={vi.fn()}
        onPersist={async () => true}
        collab={{ doc, awareness: null, user: null, canWrite: false }}
      />,
    );
    const initial = univerMock.workbooks[0];
    const initialSheet = initial.data.sheets[initial.data.sheetOrder[0]];
    initialSheet.scrollTop = 240;
    initialSheet.scrollLeft = 80;
    initialSheet.zoomRatio = 1.4;
    await waitFor(() => expect(initial.permission.setReadOnly).toHaveBeenCalled());

    await act(async () => {
      applySpreadsheetBatch(doc, { operations: [{ type: "set_values", range: "A1", values: [[42]] }] });
      await Promise.resolve();
    });
    expect(univerMock.api?.syncExecuteCommand).toHaveBeenCalledWith(
      "sheet.mutation.set-range-values",
      expect.objectContaining({ cellValue: { 0: { 0: expect.objectContaining({ v: 42 }) } } }),
      { onlyLocal: true, fromCollab: true },
    );
    expect(localOrigins).toEqual([]);

    await act(async () => {
      applySpreadsheetBatch(doc, { operations: [{ type: "rename_sheet", sheet: "Sheet1", name: "Remote" }] });
      await Promise.resolve();
    });
    expect(univerMock.workbooks).toHaveLength(2);
    const replacement = univerMock.workbooks[1];
    const replacementSheet = replacement.data.sheets[replacement.data.sheetOrder[0]];
    expect(replacementSheet).toMatchObject({ name: "Remote", scrollTop: 240, scrollLeft: 80, zoomRatio: 1.4 });
    expect(replacement.setActiveSheet).toHaveBeenCalled();
    expect(localOrigins).toEqual([]);
    view.unmount();
    doc.destroy();
  });

  it("anchors a remote pointer inside its actual zero-based cell", async () => {
    const doc = new Y.Doc();
    seedSpreadsheetDoc(doc);
    const awareness = new Awareness(doc);
    const view = render(
      <SpreadsheetEditor
        path="shared.lattice-sheet"
        source=""
        onChange={vi.fn()}
        onPersist={async () => true}
        collab={{
          doc,
          awareness,
          user: { id: "local", name: "Ada", color: "#123456" },
          canWrite: true,
        }}
      />,
    );
    const workbook = univerMock.workbooks[0];
    const markerRange = mockRange("C4");
    const getRange = vi.spyOn(workbook.sheet, "getRange").mockReturnValue(markerRange);

    act(() => {
      awareness.states.set(999, {
        user: { id: "remote", name: "Bo", color: "#654321" },
        spreadsheetPresence: {
          path: "shared.lattice-sheet",
          sheetId: workbook.sheet.getSheetId(),
          selections: [],
          pointer: { row: 3, column: 2, xRatio: 0.5, yRatio: 0.5 },
        },
      });
      awareness.emit("change", [{ added: [999], updated: [], removed: [] }, "remote"]);
    });

    await waitFor(() => expect(markerRange.attachPopup).toHaveBeenCalledOnce());
    expect(getRange).toHaveBeenCalledWith(3, 2);
    const options = markerRange.attachPopup.mock.calls[0]![0] as {
      componentKey: ComponentType<{ popup: { extraProps?: { color?: string; name?: string } } }>;
      extraProps: { color: string; name: string };
    };
    const Popup = options.componentKey;
    const popup = render(<Popup popup={{ extraProps: options.extraProps }} />);
    expect(popup.container.firstChild).toHaveStyle({ transform: "translateY(100%)" });

    popup.unmount();
    view.unmount();
    awareness.destroy();
    doc.destroy();
  });
});
