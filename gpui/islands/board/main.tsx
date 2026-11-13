/**
 * The board island: the Tauri app's `.tldr` whiteboard
 * (`src/editor/board/board-editor.tsx`, tldraw) as it is, over the document
 * its owner holds, in the host's light or dark theme.
 */
import "../shared/install";
import { mount } from "../shared/boot";
import { DocumentIsland } from "../shared/document";
import { useHostTheme } from "../shared/host";
import { BoardEditor } from "../../../src/editor/board/board-editor";
import type { BoardFileViewState } from "../../../src/app-types";

function Board() {
  const theme = useHostTheme();
  return (
    <DocumentIsland<BoardFileViewState>
      editor={(document) => (
        <BoardEditor
          path={document.path}
          source={document.source}
          onChange={document.onChange}
          onFlushPendingChange={document.onFlushPendingChange}
          active={document.active}
          initialViewState={document.initialViewState}
          onViewState={document.onViewState}
          theme={theme}
        />
      )}
    />
  );
}

mount(() => <Board />);
