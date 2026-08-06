import {
  createContext,
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentProps,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
} from "react";
import type { ComarkNode, ComarkTree } from "@comark/react";
import { Binding } from "@comark/react/plugins/binding";
import { ComarkRenderer } from "@comark/react/components/ComarkRenderer";
import { openUrl } from "@tauri-apps/plugin-opener";
import katex from "katex";
import { Check, Pencil, RotateCcw, X, ZoomIn, ZoomOut } from "lucide-react";
import { createComarkMarkdownParser } from "./chat-markdown-renderer";
import "katex/dist/katex.min.css";

const EMPTY_MACROS: Record<string, string> = {};
const mermaidSvgCache = new Map<string, string>();

type MarkdownBlockRange = {
  startLine: number;
  endLine: number;
};

type MarkdownEditSession = MarkdownBlockRange & {
  sourceText: string;
  original: string;
  draft: string;
  error: string | null;
};

type MarkdownEditingContextValue = {
  editing: MarkdownEditSession | null;
  begin: (range: MarkdownBlockRange) => void;
  update: (draft: string) => void;
  commit: () => void;
  cancel: () => void;
};

const MarkdownEditingContext = createContext<MarkdownEditingContextValue | null>(null);
const MarkdownPreviewCurrentContext = createContext(true);

function markdownLines(text: string, startLine: number, endLine: number): string {
  const lines = text.split("\n").slice(startLine - 1, endLine);
  const last = lines.length - 1;
  if (last >= 0 && lines[last].endsWith("\r")) lines[last] = lines[last].slice(0, -1);
  return lines.join("\n");
}

function EditableMarkdownBlock({
  tag: Tag,
  children,
  className = "",
  "data-source-line": sourceLine,
  "data-source-end-line": sourceEndLine,
  editLabel,
  $: _metadata,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  tag: ElementType;
  "data-source-line"?: number | string;
  "data-source-end-line"?: number | string;
  editLabel?: string;
  $?: unknown;
}) {
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const cancellingRef = useRef(false);
  void _metadata;
  const editingContext = useContext(MarkdownEditingContext);
  const startLine = Number(sourceLine);
  const endLine = Number(sourceEndLine);
  const editable = editingContext !== null
    && Number.isInteger(startLine)
    && Number.isInteger(endLine)
    && endLine >= startLine;
  const active = editable
    && editingContext.editing?.startLine === startLine
    && editingContext.editing.endLine === endLine;
  const label = editLabel ?? (typeof Tag !== "string"
    ? "block"
    : Tag === "p"
      ? "paragraph"
      : Tag === "pre"
        ? "code block"
        : Tag === "ul" || Tag === "ol"
          ? "list"
          : Tag.replace(/^h([1-6])$/, "heading $1"));

  if (!editable) {
    return (
      <Tag
        {...props}
        className={className}
        data-source-line={sourceLine}
        data-source-end-line={sourceEndLine}
      >
        {children}
      </Tag>
    );
  }
  if (active && editingContext.editing) {
    const session = editingContext.editing;
    const finishAndRestoreFocus = (finish: () => void, cancelling = false) => {
      const root = editorRef.current?.closest(".chat-markdown");
      const host = root?.parentElement;
      const focusEditButton = () => {
        const exact = host?.querySelector<HTMLButtonElement>(
          `.markdown-editable-block[data-source-line="${startLine}"][data-source-end-line="${endLine}"] > .markdown-block-edit-button`,
        );
        const button = exact ?? host?.querySelector<HTMLButtonElement>(
          `.markdown-editable-block[data-source-line="${startLine}"] > .markdown-block-edit-button`,
        );
        button?.focus();
        return Boolean(button);
      };
      cancellingRef.current = cancelling;
      finish();
      requestAnimationFrame(() => {
        if (focusEditButton() || !host) return;
        const observer = new MutationObserver(() => {
          if (focusEditButton()) observer.disconnect();
        });
        observer.observe(host, { childList: true, subtree: true });
        window.setTimeout(() => observer.disconnect(), 1_000);
      });
    };
    return (
      <div
        className="markdown-block-editor"
        data-source-line={startLine}
        data-source-end-line={endLine}
        onBlur={(event) => {
          if (
            !cancellingRef.current
            && !event.currentTarget.contains(event.relatedTarget as Node | null)
          ) {
            editingContext.commit();
          }
        }}
      >
        <textarea
          ref={editorRef}
          autoFocus
          aria-label={`Edit ${label} Markdown`}
          value={session.draft}
          rows={Math.max(1, session.draft.split("\n").length)}
          onChange={(event) => editingContext.update(event.currentTarget.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Escape") {
              event.preventDefault();
              finishAndRestoreFocus(editingContext.cancel, true);
            } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              finishAndRestoreFocus(editingContext.commit);
            }
          }}
        />
        <div className="markdown-block-editor-actions">
          {session.error ? <span role="alert">{session.error}</span> : <span>Markdown source</span>}
          <button type="button" onClick={() => finishAndRestoreFocus(editingContext.cancel, true)}>
            <X size={13} aria-hidden="true" /> Cancel
          </button>
          <button type="button" onClick={() => finishAndRestoreFocus(editingContext.commit)}>
            <Check size={13} aria-hidden="true" /> Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="markdown-editable-block"
      data-source-line={startLine}
      data-source-end-line={endLine}
      onDoubleClick={(event) => {
        const target = event.target;
        if (target instanceof Element && target.closest("a, button, input, textarea, select")) return;
        editingContext.begin({ startLine, endLine });
      }}
    >
      <Tag {...props} className={className}>{children}</Tag>
      <button
        type="button"
        className="markdown-block-edit-button"
        aria-label={`Edit ${label} Markdown`}
        title="Edit Markdown block"
        onClick={() => editingContext.begin({ startLine, endLine })}
      >
        <Pencil size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function editableComponent(as: ElementType) {
  return function EditableComponent(props: ComponentPropsWithoutRef<"div"> & {
    "data-source-line"?: number | string;
    "data-source-end-line"?: number | string;
    $?: unknown;
  }) {
    return <EditableMarkdownBlock {...props} tag={as} />;
  };
}

const EditableParagraph = editableComponent("p");
const EditableHeading1 = editableComponent("h1");
const EditableHeading2 = editableComponent("h2");
const EditableHeading3 = editableComponent("h3");
const EditableHeading4 = editableComponent("h4");
const EditableHeading5 = editableComponent("h5");
const EditableHeading6 = editableComponent("h6");
const EditableBlockquote = editableComponent("blockquote");
const EditableUnorderedList = editableComponent("ul");
const EditableOrderedList = editableComponent("ol");
const EditableTable = editableComponent("table");
const EditablePre = editableComponent("pre");

function resolveProjectLink(activePath: string, href: string): string | null {
  const rawPath = href.split(/[?#]/, 1)[0];
  if (!rawPath || rawPath.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(rawPath)) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath).replace(/\\/g, "/");
  } catch {
    return null;
  }
  const parts = decoded.startsWith("/")
    ? []
    : activePath.replace(/\\/g, "/").split("/").slice(0, -1).filter(Boolean);
  for (const part of decoded.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/") || null;
}

function ExternalLink(componentProps: ComponentPropsWithoutRef<"a"> & {
  $?: unknown;
  activePath: string;
  onOpenProjectPath?: (path: string) => void;
}) {
  const {
    href,
    children,
    $: metadata,
    activePath,
    onOpenProjectPath,
    ...props
  } = componentProps;
  void metadata;
  return (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        if (!href) return;
        if (/^(?:https?:|mailto:)/i.test(href)) {
          void openUrl(href).catch(() => undefined);
          return;
        }
        if (href.startsWith("#")) {
          const id = decodeURIComponent(href.slice(1));
          event.currentTarget.closest(".chat-markdown")?.querySelector<HTMLElement>(`#${CSS.escape(id)}`)?.scrollIntoView();
          return;
        }
        const path = resolveProjectLink(activePath, href);
        if (path) onOpenProjectPath?.(path);
      }}
    >
      {children}
    </a>
  );
}

export const MarkdownMath = memo(function MarkdownMath({
  content,
  className = "",
  macros,
  "data-source-line": sourceLine,
  children: _children,
  $: _metadata,
  ...props
}: ComponentPropsWithoutRef<"div"> & {
  content: string;
  className?: string;
  macros: Record<string, string>;
  "data-source-line"?: number | string;
  $?: unknown;
}) {
  void _children;
  void _metadata;
  const display = className.includes("block");
  const result = useMemo(() => {
    try {
      return {
        html: katex.renderToString(content, {
          displayMode: display,
          throwOnError: false,
          strict: "ignore",
          macros,
        }),
        error: null,
      };
    } catch (reason) {
      return {
        html: null,
        error: reason instanceof Error ? reason.message : String(reason),
      };
    }
  }, [content, display, macros]);

  if (result.error) {
    return (
      <code
        {...props}
        className={`chat-math-error ${className}`.trim()}
        data-source-line={sourceLine}
        title={result.error}
      >
        {content}
      </code>
    );
  }
  const Tag = display ? "div" : "span";
  return (
    <Tag
      {...props}
      className={`${display ? "chat-math-block" : "math-inline"} ${className}`.trim()}
      data-source-line={sourceLine}
      dangerouslySetInnerHTML={{ __html: result.html ?? "" }}
    />
  );
});

const MarkdownMermaid = memo(function MarkdownMermaid({
  content,
  className = "",
  "data-source-line": sourceLine,
  children: _children,
  $: _metadata,
  ...props
}: ComponentPropsWithoutRef<"figure"> & {
  content: string;
  className?: string;
  "data-source-line"?: number | string;
  $?: unknown;
}) {
  void _children;
  void _metadata;
  const [dark, setDark] = useState(() => (
    typeof document !== "undefined" && document.documentElement.dataset.theme === "dark"
  ));

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setDark(root.dataset.theme === "dark");
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  const [diagram, setDiagram] = useState<{ src: string | null; error: string | null }>({
    src: null,
    error: null,
  });
  const [scale, setScale] = useState(1);
  useEffect(() => {
    let current = true;
    const cacheKey = `${Number(dark)}:${content}`;
    const cached = mermaidSvgCache.get(cacheKey);
    if (cached) {
      void Promise.resolve().then(() => {
        if (current) setDiagram({ src: cached, error: null });
      });
      return () => {
        current = false;
      };
    }
    void import("beautiful-mermaid")
      .then(({ renderMermaidSVG, THEMES }) => {
        const svg = renderMermaidSVG(content, THEMES[dark ? "tokyo-night" : "tokyo-light"]);
        if (current) {
          const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
          mermaidSvgCache.set(cacheKey, src);
          setDiagram({
            src,
            error: null,
          });
        }
      })
      .catch((reason: unknown) => {
        if (current) {
          setDiagram({
            src: null,
            error: reason instanceof Error ? reason.message : String(reason),
          });
        }
      });
    return () => {
      current = false;
    };
  }, [content, dark]);

  const diagramLabel = typeof props["aria-label"] === "string"
    ? props["aria-label"]
    : "Mermaid diagram";
  return (
    <figure
      {...props}
      className={`chat-mermaid ${className}`.trim()}
      data-source-line={sourceLine}
      aria-busy={!diagram.src}
    >
      {diagram.error ? (
        <pre className="chat-mermaid-error" title={diagram.error}>
          <code>{content}</code>
        </pre>
      ) : diagram.src ? (
        <>
          <div className="chat-mermaid-toolbar" role="group" aria-label="Diagram zoom">
            <button
              type="button"
              aria-label="Zoom out diagram"
              title="Zoom out"
              disabled={scale <= 0.5}
              onClick={() => setScale((current) => Math.max(0.5, current - 0.25))}
            >
              <ZoomOut size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              aria-label="Reset diagram zoom"
              title="Reset zoom"
              disabled={scale === 1}
              onClick={() => setScale(1)}
            >
              <RotateCcw size={13} aria-hidden="true" />
              <span aria-live="polite" aria-atomic="true">{Math.round(scale * 100)}%</span>
            </button>
            <button
              type="button"
              aria-label="Zoom in diagram"
              title="Zoom in"
              disabled={scale >= 2}
              onClick={() => setScale((current) => Math.min(2, current + 0.25))}
            >
              <ZoomIn size={14} aria-hidden="true" />
            </button>
          </div>
          <div className="chat-mermaid-stage">
            <img
              src={diagram.src}
              alt={diagramLabel}
              style={{ width: `${scale * 100}%` }}
            />
          </div>
        </>
      ) : null}
    </figure>
  );
});

function MarkdownTaskCheckbox({
  checked,
  disabled: _disabled,
  children: _children,
  $: _metadata,
  "data-task-line": taskLine,
  onToggle,
  ...props
}: Omit<ComponentPropsWithoutRef<"input">, "onToggle"> & {
  $?: unknown;
  "data-task-line"?: number | string;
  onToggle?: (line: number, checked: boolean) => void;
}) {
  void _disabled;
  void _children;
  void _metadata;
  const previewCurrent = useContext(MarkdownPreviewCurrentContext);
  const line = Number(taskLine);
  const editable = previewCurrent && onToggle !== undefined && Number.isInteger(line);
  return (
    <input
      {...props}
      type="checkbox"
      checked={Boolean(checked)}
      disabled={!editable}
      onChange={(event) => {
        if (editable) onToggle(line, event.currentTarget.checked);
      }}
    />
  );
}

type RichMarkdownNodeProps = ComponentPropsWithoutRef<"div"> & {
  content: string;
  className?: string;
  "data-source-line"?: number | string;
  "data-source-end-line"?: number | string;
  $?: unknown;
};

function EditableMermaid(props: RichMarkdownNodeProps) {
  const {
    "data-source-line": sourceLine,
    "data-source-end-line": sourceEndLine,
    ...mermaidProps
  } = props;
  return (
    <EditableMarkdownBlock
      tag="div"
      className="markdown-rich-editable-block"
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
      editLabel="diagram"
    >
      <MarkdownMermaid {...mermaidProps} />
    </EditableMarkdownBlock>
  );
}

function EditableMath(props: RichMarkdownNodeProps & { macros: Record<string, string> }) {
  if (!props.className?.includes("block")) return <MarkdownMath {...props} />;
  const {
    "data-source-line": sourceLine,
    "data-source-end-line": sourceEndLine,
    ...mathProps
  } = props;
  return (
    <EditableMarkdownBlock
      tag="div"
      className="markdown-rich-editable-block"
      data-source-line={sourceLine}
      data-source-end-line={sourceEndLine}
      editLabel="formula"
    >
      <MarkdownMath {...mathProps} />
    </EditableMarkdownBlock>
  );
}

function nodeSignature(node: ComarkNode): string {
  const serialized = JSON.stringify(
    node,
    (key, value) => (
      key === "$" || key === "data-source-line" || key === "data-source-end-line"
        ? undefined
        : value
    ),
  );
  let hash = 2166136261;
  for (let index = 0; index < serialized.length; index += 1) {
    hash ^= serialized.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function renderableTopLevelNode(node: ComarkNode): ComarkNode {
  if (!Array.isArray(node) || !node[1].$) return node;
  const attributes = { ...node[1] };
  delete attributes.$;
  return [node[0], attributes, ...node.slice(2)] as ComarkNode;
}

function StableComarkRenderer({ tree, components, className }: {
  tree: ComarkTree;
  components: NonNullable<ComponentProps<typeof ComarkRenderer>["components"]>;
  className?: string;
}) {
  const occurrences = new Map<string, number>();
  return (
    <div className={`comark-content ${className ?? ""}`}>
      {tree.nodes.map((node) => {
        const signature = nodeSignature(node);
        const occurrence = occurrences.get(signature) ?? 0;
        occurrences.set(signature, occurrence + 1);
        return (
          <ComarkRenderer
            key={`${signature}:${occurrence}`}
            tree={{ ...tree, nodes: [renderableTopLevelNode(node)] }}
            components={components}
            className="chat-markdown-block"
          />
        );
      })}
    </div>
  );
}

export function ChatMarkdown({
  text,
  macros,
  className,
  breaks,
  activePath,
  onOpenProjectPath,
  onToggleTask,
  onReplaceBlock,
}: {
  text: string;
  macros?: Record<string, string>;
  className?: string;
  breaks?: boolean;
  activePath?: string;
  onOpenProjectPath?: (path: string) => void;
  onToggleTask?: (line: number, checked: boolean) => void;
  onReplaceBlock?: (
    range: MarkdownBlockRange,
    replacement: string,
    expected: string,
  ) => boolean;
}) {
  const katexMacros = macros ?? EMPTY_MACROS;
  const [editing, setEditing] = useState<MarkdownEditSession | null>(null);
  const currentEditing = editing?.sourceText === text ? editing : null;
  const beginEditing = (range: MarkdownBlockRange) => {
    const original = markdownLines(text, range.startLine, range.endLine);
    setEditing({ ...range, sourceText: text, original, draft: original, error: null });
  };
  const updateEditing = (draft: string) => {
    setEditing((current) => current ? { ...current, draft, error: null } : null);
  };
  const cancelEditing = () => setEditing(null);
  const commitEditing = () => {
    if (!currentEditing || !onReplaceBlock) return;
    const currentSource = markdownLines(text, currentEditing.startLine, currentEditing.endLine);
    if (currentSource !== currentEditing.original) {
      setEditing((current) => current ? {
        ...current,
        error: "This block changed elsewhere. Cancel and reopen it before saving.",
      } : null);
      return;
    }
    const accepted = onReplaceBlock(
      { startLine: currentEditing.startLine, endLine: currentEditing.endLine },
      currentEditing.draft,
      currentEditing.original,
    );
    if (accepted) setEditing(null);
    else {
      setEditing((current) => current ? {
        ...current,
        error: "The source changed before this edit could be applied.",
      } : null);
    }
  };
  const editingContext = onReplaceBlock ? {
    editing: currentEditing,
    begin: beginEditing,
    update: updateEditing,
    commit: commitEditing,
    cancel: cancelEditing,
  } : null;
  const components = useMemo(() => ({
    a: (props: ComponentPropsWithoutRef<"a"> & { $?: unknown }) => (
      <ExternalLink
        {...props}
        activePath={activePath ?? ""}
        onOpenProjectPath={onOpenProjectPath}
      />
    ),
    p: EditableParagraph,
    h1: EditableHeading1,
    h2: EditableHeading2,
    h3: EditableHeading3,
    h4: EditableHeading4,
    h5: EditableHeading5,
    h6: EditableHeading6,
    blockquote: EditableBlockquote,
    ul: EditableUnorderedList,
    ol: EditableOrderedList,
    table: EditableTable,
    pre: EditablePre,
    math: (props: RichMarkdownNodeProps & { children?: ReactNode }) => (
      <EditableMath {...props} macros={katexMacros} />
    ),
    mermaid: EditableMermaid,
    binding: Binding,
    input: (props: ComponentPropsWithoutRef<"input"> & {
      $?: unknown;
      "data-task-line"?: number | string;
    }) => <MarkdownTaskCheckbox {...props} onToggle={onToggleTask} />,
  }), [activePath, katexMacros, onOpenProjectPath, onToggleTask]);
  const softBreaks = breaks ?? true;
  const parse = useMemo(() => createComarkMarkdownParser(), []);
  const [parsed, setParsed] = useState<{ text: string; tree: ComarkTree } | null>(null);

  useEffect(() => {
    let current = true;
    void parse(text, softBreaks)
      .then((parsed) => {
        if (current) setParsed({ text, tree: parsed });
      })
      .catch(() => {
        if (current) setParsed({
          text,
          tree: { nodes: [text], frontmatter: {}, meta: {} },
        });
      });
    return () => {
      current = false;
    };
  }, [parse, softBreaks, text]);

  if (!parsed) return null;
  const previewCurrent = parsed.text === text;

  return (
    <MarkdownPreviewCurrentContext.Provider value={previewCurrent}>
      <MarkdownEditingContext.Provider value={previewCurrent ? editingContext : null}>
        <StableComarkRenderer
          tree={parsed.tree}
          components={components}
          className={className ? `chat-markdown ${className}` : "chat-markdown"}
        />
      </MarkdownEditingContext.Provider>
    </MarkdownPreviewCurrentContext.Provider>
  );
}
