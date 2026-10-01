import { CircleDot, ListTodo } from "lucide-react";
import { Trans, useLingui } from "@lingui/react/macro";
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
        <p className="drawer-copy">
          <Trans>Finds `% TODO`, `% FIXME`, `% XXX` and `\todo`</Trans>
        </p>
        <div className="project-replace-preview-summary">
          {count === 0
            ? t`No TODO markers found`
            : count === 1
              ? t`${count} marker`
              : t`${count} markers`}
        </div>
        <ul className="project-replace-hits todo-hits">
          {props.hits.map((hit) => (
            <li key={`${hit.path}:${hit.line}:${hit.kind}:${hit.preview}`}>
              <button
                type="button"
                className="project-replace-hit"
                onClick={() => props.onOpen(hit.path, hit.line)}
              >
                <span className="project-replace-hit-path">
                  <CircleDot size={10} className={`todo-kind ${hit.kind.toLowerCase()}`} />
                  {hit.kind} · {hit.path}:{hit.line}
                </span>
                <span className="project-replace-hit-preview">{hit.preview}</span>
              </button>
            </li>
          ))}
        </ul>
    </ResizableDrawer>
  );
}
