import ReactDOM from "react-dom/client";
import { I18nProvider } from "@lingui/react";
import { Navigator } from "../src/project/navigator";
import { activateAppLocale, i18n } from "../src/i18n";
import "../src/index.css";
import "../src/App.css";

const noop = () => {};
const resolved = async (paths: string[]) => paths;

export async function mountNavigatorScrollMotionFixture() {
  await activateAppLocale("en");
  localStorage.clear();
  document.body.replaceChildren();
  const shell = document.createElement("div");
  shell.className = "app-shell";
  shell.style.cssText = "position:fixed;inset:0;background:var(--surface-sidebar)";
  document.body.append(shell);
  ReactDOM.createRoot(shell).render(
    <I18nProvider i18n={i18n}>
      <div className="titlebar" />
      <main className="workspace" style={{ gridTemplateColumns: "280px 1px minmax(0, 1fr)", gridTemplateAreas: '"sidebar sidebar-resizer canvas"' }}>
      <section className="shared-sidebar">
      <div className="workspace-sidebar-content" style={{ width: 280 }}>
      <div className="sidebar-mode-header">Project</div>
      <div className="sidebar-pane">
        <Navigator
          mode="project" projectKey="/tmp/scroll-motion" searchOpen={false}
          onSearchOpenChange={noop} files={[
            { name: "chapters", path: "chapters", kind: "directory", children: Array.from({ length: 70 }, (_, i) => ({ name: `chapter-${i}.tex`, path: `chapters/chapter-${i}.tex`, kind: "tex", children: [] })) },
            ...Array.from({ length: 80 }, (_, i) => ({ name: `notes-${String(i).padStart(2, "0")}.tex`, path: `notes-${String(i).padStart(2, "0")}.tex`, kind: "tex", children: [] })),
          ]}
          gitStatus={[]} activeFile="" activeAssetPath="" protectedPaths={[]}
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
      </div>
      </div>
      </section>
      <div className="canvas-panel" />
      </main>
    </I18nProvider>,
  );
  await new Promise((resolve) => setTimeout(resolve, 500));
}
