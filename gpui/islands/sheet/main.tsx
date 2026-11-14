/**
 * The spreadsheet island: the Tauri app's `.lattice-sheet` editor
 * (`src/editor/spreadsheet/spreadsheet-editor.tsx`, Univer) as it is, over
 * the document its owner holds. Export to Excel goes through the app's own
 * code to `save_xlsx` and the native save panel, both of which the owner
 * answers (`tauri:invoke`).
 */
import "../shared/install";
import { mount } from "../shared/boot";
import { DocumentIsland } from "../shared/document";
import { SpreadsheetEditor } from "../../../src/editor/spreadsheet/spreadsheet-editor";
import type { SpreadsheetFileViewState } from "../../../src/app-types";

mount(() => (
  <DocumentIsland<SpreadsheetFileViewState>
    editor={(document) => (
      <SpreadsheetEditor
        path={document.path}
        source={document.source}
        onChange={document.onChange}
        onPersist={document.onPersist}
        onFlushPendingChange={document.onFlushPendingChange}
        active={document.active}
        initialViewState={document.initialViewState}
        onViewState={document.onViewState}
      />
    )}
  />
));
