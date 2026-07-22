import { useEffect, useState } from "react";
import { X } from "lucide-react";

export type EditorTab = {
  path: string;
  dirty?: boolean;
  beside?: boolean;
  kind?: "file" | "paper";
  label?: string;
};

function tabLabel(tab: EditorTab): string {
  if (tab.label) return tab.label;
  const parts = tab.path.split("/");
  return parts[parts.length - 1] || tab.path;
}

export function EditorTabs(props: {
  tabs: EditorTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
  onReorder: (nextPaths: string[]) => void;
}) {
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [dropKey, setDropKey] = useState<string | null>(null);

  const reorder = (from: string, to: string) => {
    if (from === to) return;
    const paths = props.tabs.map((tab) => tab.path);
    const fromIdx = paths.indexOf(from);
    const toIdx = paths.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    const without = paths.filter((path) => path !== from);
    // Dropping onto a tab lands before it when moving left, after it moving right.
    const insertAt = without.indexOf(to) + (fromIdx < toIdx ? 1 : 0);
    without.splice(insertAt, 0, from);
    props.onReorder(without);
  };

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  if (props.tabs.length <= 1) return null;

  return (
    <div className="editor-tabs">
      <div className="editor-tabs-scroll" role="tablist" aria-label="Open files">
        {props.tabs.map((tab) => {
          const active = tab.path === props.activePath;
          return (
            <div
              key={tab.path}
              className={`editor-tab ${active ? "active" : ""}${tab.beside ? " beside" : ""}${dragKey === tab.path ? " dragging" : ""}${dropKey === tab.path ? " drop-target" : ""}`}
              role="presentation"
              draggable
              onDragStart={(event) => {
                setDragKey(tab.path);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                if (!dragKey || dragKey === tab.path) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                setDropKey(tab.path);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (dragKey) reorder(dragKey, tab.path);
                setDragKey(null);
                setDropKey(null);
              }}
              onDragEnd={() => {
                setDragKey(null);
                setDropKey(null);
              }}
              onAuxClick={(event) => {
                if (event.button !== 1) return;
                event.preventDefault();
                props.onClose(tab.path);
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ path: tab.path, x: event.clientX, y: event.clientY });
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={active}
                title={`${tab.label ?? tab.path} · middle-click close · ⌘⇧T reopen`}
                onClick={() => {
                  props.onSelect(tab.path);
                }}
              >
                <span>{tabLabel(tab)}</span>
                {tab.dirty && <i aria-label="Unsaved changes" />}
              </button>
              <button
                type="button"
                className="editor-tab-close"
                title={`Close ${tabLabel(tab)}`}
                onClick={(event) => {
                  event.stopPropagation();
                  props.onClose(tab.path);
                }}
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
      </div>
      {menu && (
        <div
          className="editor-tab-menu"
          style={{ left: menu.x, top: menu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              props.onSelect(menu.path);
              setMenu(null);
            }}
          >
            Open
          </button>
          <button
            type="button"
            onClick={() => {
              props.onClose(menu.path);
              setMenu(null);
            }}
          >
            Close
          </button>
        </div>
      )}
    </div>
  );
}
