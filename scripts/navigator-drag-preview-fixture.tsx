import ReactDOM from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { Navigator } from "../src/project/navigator";
import { activateAppLocale, i18n } from "../src/i18n";
import "../src/index.css";
import "../src/App.css";

const noop = () => {};
const resolved = async (paths: string[]) => paths;

export async function mountNavigatorDragPreviewFixture() {
  await activateAppLocale("en");
  document.body.replaceChildren();
  const shell = document.createElement("div");
  shell.innerHTML = `
    <div id="navigator-drag-fixture"></div>
    <div data-fixture-editor><div>Split editor</div><div>Drag preview must remain above this pane</div></div>
  `;
  document.body.append(shell);
  const style = document.createElement("style");
  style.textContent = `
    body { margin: 0; background: var(--surface-canvas); }
    #navigator-drag-fixture { position: fixed; inset: 0 auto 0 0; z-index: 1; width: 260px; background: var(--surface-panel); }
    #navigator-drag-fixture > div { height: 100%; }
    [data-fixture-editor] { position: fixed; inset: 0 0 0 260px; z-index: 20; display: grid; grid-template-columns: 1fr 1fr; gap: 1px; padding: 80px 30px; background: #d8d8da; color: #303036; font: 18px system-ui; }
    [data-fixture-editor] > div { padding: 40px; background: #fafafa; box-shadow: 0 0 0 1px #bbb; }
  `;
  document.head.append(style);
  ReactDOM.createRoot(document.querySelector("#navigator-drag-fixture")!).render(
    <I18nProvider i18n={i18n}>
      <Navigator
        mode="project" projectKey="/tmp/drag-preview" searchOpen={false}
        onSearchOpenChange={noop} files={[
          { name: "chapter-one.tex", path: "chapter-one.tex", kind: "tex", children: [] },
          { name: "chapter-two.tex", path: "chapter-two.tex", kind: "tex", children: [] },
        ]}
        gitStatus={[]} activeFile="chapter-one.tex" activeAssetPath="" protectedPaths={[]}
        papers={[]} activePaper={null} onFile={noop} onAsset={noop}
        onBeginFigureDrag={noop} onBeginFileDrag={noop}
        onCreateEntry={async (path) => path} onDeleteEntries={noop}
        onRenameEntry={async (path) => path} onMoveEntries={resolved} onCopyEntries={resolved}
        onError={(error) => { throw new Error(error); }} onReveal={noop}
        onImportAssets={noop} onPasteImage={noop} assetDropTarget={null} assetImporting={false}
        onPaper={noop} onFetchFullText={noop} paperFetchStates={{}} onDeletePaper={noop}
        onEditBibEntry={noop} importInput="" setImportInput={noop} onImport={noop}
        onCancelImport={noop} importing={false}
      />
    </I18nProvider>,
  );
  const deadline = performance.now() + 3000;
  while (performance.now() < deadline) {
    const row = document.querySelector("file-tree-container.lattice-file-tree")?.shadowRoot
      ?.querySelector<HTMLElement>("[data-item-path='chapter-one.tex']");
    if (row) {
      const rect = row.getBoundingClientRect();
      return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Navigator row did not render");
}
