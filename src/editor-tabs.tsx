import { useEffect, useState } from "react";
import { X } from "lucide-react";

export type EditorTab = {
  path: string;
  dirty?: boolean;
  beside?: boolean;
};

function tabLabel(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function EditorTabs(props: {
  tabs: EditorTab[];
  activePath: string;
  onSelect: (path: string) => void;
  onClose: (path: string) => void;
}) {
  const [menu, setMenu] = useState<{ path: string; x: number; y: number } | null>(null);

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
              className={`editor-tab ${active ? "active" : ""}${tab.beside ? " beside" : ""}`}
              role="presentation"
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
                title={`${tab.path} · middle-click close · ⌘⇧T reopen`}
                onClick={() => {
                  props.onSelect(tab.path);
                }}
              >
                <span>{tabLabel(tab.path)}</span>
                {tab.dirty && <i aria-label="Unsaved changes" />}
              </button>
              <button
                type="button"
                className="editor-tab-close"
                title={`Close ${tabLabel(tab.path)}`}
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
