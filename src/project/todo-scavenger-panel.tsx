import { CircleDot, ListTodo } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
import { EmptyState } from "../components/ui/empty-state";
import { EmptyIllustration } from "../components/ui/empty-illustration";
import { PanelHeader } from "../components/ui/panel-header";
import type { TodoHit } from "./todo-scavenger";
import { ResizableDrawer } from "../components/ui/resizable-drawer";

export function TodoScavengerPanel(props: {
  hits: TodoHit[];
  onClose: () => void;
  onOpen: (path: string, line: number) => void;
}) {
  const { t } = useLingui();
  const count = props.hits.length;
  return (
    <ResizableDrawer className="todo-drawer" onClose={props.onClose}>
        <PanelHeader
          className="drawer-header"
          icon={<ListTodo size={16} />}
          title={t`Manuscript TODOs`}
          onClose={props.onClose}
        />
        {/* What counts as a marker matters only while there are none. */}
        {count === 0 ? (
          <EmptyState
            className="todo-empty"
            icon={<EmptyIllustration kind="done" />}
            title={t`No TODO markers found`}
            description={<Trans>Looks for <code>% TODO</code>, <code>% FIXME</code>, <code>% XXX</code> and <code>\todo</code></Trans>}
          />
        ) : (
          <div className="project-replace-preview-summary">
            {count === 1 ? t`${count} marker` : t`${count} markers`}
          </div>
        )}
        <ul className="project-replace-hits todo-hits">
          {props.hits.map((hit) => (
            <li key={`${hit.path}:${hit.line}:${hit.kind}:${hit.preview}`}>
              <button
                type="button"
                className="project-replace-hit"
                onClick={() => props.onOpen(hit.path, hit.line)}
              >
                <span className="project-find-hit-icon" aria-hidden="true">
                  <CircleDot size={12} className={`todo-kind ${hit.kind.toLowerCase()}`} />
                </span>
                <span className="project-find-hit-heading">
                  <span className="project-find-hit-name">{hit.kind}</span>
                  <span className="project-find-hit-folder">{hit.path}</span>
                  <span className="project-find-hit-line">{hit.line}</span>
                </span>
                <span className="project-replace-hit-preview">{hit.preview}</span>
              </button>
            </li>
          ))}
        </ul>
    </ResizableDrawer>
  );
}
