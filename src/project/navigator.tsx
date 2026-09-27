import { PaperLibrary, type PaperLibraryProps } from "./paper-library";
import { ProjectFileTree, type ProjectFileTreeProps } from "./project-file-tree";

type NavigatorProps = ProjectFileTreeProps & PaperLibraryProps & {
  onFile: (path: string, line?: number) => void;
};

/** The sidebar: the project file tree or the paper library. */
export function Navigator(props: NavigatorProps) {
  return (
    <aside className={`navigator ${props.assetDropTarget != null ? "asset-drag-active" : ""}`}>
      {props.mode === "project" && (
        <div className="navigator-section project-section">
          <ProjectFileTree key={props.projectKey} {...props} />
        </div>
      )}
      <PaperLibrary {...props} />
    </aside>
  );
}
