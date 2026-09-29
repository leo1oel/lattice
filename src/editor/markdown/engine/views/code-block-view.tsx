/**
 * The visual engine's code block (spec R-BLK-7, R-FMT-8, R-BLK-5): the code
 * stays ordinary editable text, highlighted by decorations, under a quiet
 * header with the language picker, the fence title, Copy, settings and
 * Delete. A Mermaid block shows its rendered diagram instead of its code
 * until the reader asks for the code.
 *
 * Clean implementation for Lattice; spec: docs/visual-editor-spec.md.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { useLingui } from "@lingui/react/macro";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Check, ChevronDown, Copy, Eye, EyeOff, Settings2, Trash2 } from "lucide-react";
import { IconButton } from "../../../../components/ui/icon-button";
import { Input } from "../../../../components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "../../../../components/ui/popover";
import {
  CODE_LANGUAGES, codeLanguageLabel, metaTitle, metaWidth, rendersMermaid, resolveCodeLanguage, withMetaTitle, withMetaWidth,
} from "../code-languages";
import { MermaidDiagram } from "./mermaid-preview";
import { deleteNode, Field, setNodeAttrs, useCommitKeys } from "./view-chrome";

const MIN_PREVIEW_WIDTH = 160;

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    await writeText(text);
  }
}

export function CodeBlockView(props: NodeViewProps) {
  const { t } = useLingui();
  const { node, editor, getPos } = props;
  const language = node.attrs.language as string | null;
  const meta = node.attrs.meta as string | null;
  const title = metaTitle(meta);
  const mermaid = rendersMermaid(node.attrs);
  const [previewShown, setPreviewShown] = useState(true);
  const preview = mermaid && previewShown;
  const [copied, setCopied] = useState(false);
  const editable = editor.isEditable;
  const code = node.textContent;

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1400);
    return () => clearTimeout(timer);
  }, [copied]);

  const setMeta = (next: string | null) => setNodeAttrs(editor, getPos, node, { meta: next });

  return (
    <NodeViewWrapper
      className={`lx-md-code${props.selected ? " is-selected" : ""}`}
      data-language={language ?? undefined}
      data-code-visible={!preview}
    >
      <div className="lx-md-code-header" contentEditable={false}>
        {editable
          ? <LanguagePicker language={language} onPick={(value) => setNodeAttrs(editor, getPos, node, { language: value })} />
          : <span className="lx-md-code-language">{codeLanguageLabel(language)}</span>}
        {title && !preview && <span className="lx-md-code-title">{title}</span>}
        <span className="lx-md-code-actions">
          {mermaid && (
            <IconButton
              size="compact"
              tooltip={false}
              label={previewShown ? t`Hide Mermaid preview` : t`Show Mermaid preview`}
              onClick={() => setPreviewShown(!previewShown)}
            >
              {previewShown ? <EyeOff aria-hidden="true" /> : <Eye aria-hidden="true" />}
            </IconButton>
          )}
          <IconButton
            size="compact"
            tooltip={false}
            label={copied ? t`Copied` : t`Copy code`}
            onClick={() => {
              void copyText(code).then(() => setCopied(true));
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          </IconButton>
          {editable && <CodeSettings title={title} onCommit={(next) => setMeta(withMetaTitle(meta, next))} />}
          {editable && (
            <IconButton size="compact" tooltip={false} label={t`Delete code block`} onClick={() => deleteNode(editor, getPos, node)}>
              <Trash2 aria-hidden="true" />
            </IconButton>
          )}
        </span>
      </div>
      {preview && (
        <PreviewSurface
          title={title}
          width={metaWidth(meta)}
          editable={editable}
          onResize={(width) => setMeta(withMetaWidth(meta, width))}
        >
          <MermaidDiagram chart={code} />
        </PreviewSurface>
      )}
      <pre className="lx-md-code-pre" hidden={preview} spellCheck={false}>
        <NodeViewContent<"code"> as="code" className={language ? `language-${language}` : undefined} />
      </pre>
    </NodeViewWrapper>
  );
}

/** The language button and its filterable list (R-FMT-8: only the language token changes). */
function LanguagePicker({ language, onPick }: { language: string | null; onPick: (value: string) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const currentLabel = codeLanguageLabel(language);
  const current = resolveCodeLanguage(language)?.value ?? (language ? null : "text");
  const options = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return CODE_LANGUAGES;
    return CODE_LANGUAGES.filter((option) => option.label.toLowerCase().includes(needle)
      || option.value.includes(needle) || option.aliases?.some((alias) => alias.includes(needle)));
  }, [query]);
  const pick = (value: string) => {
    setOpen(false);
    if (value !== language) onPick(value);
  };
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setQuery("");
        // Open on the current language, so the list shows where the block stands.
        setActive(Math.max(0, CODE_LANGUAGES.findIndex((option) => option.value === current)));
      }}
    >
      <PopoverTrigger asChild>
        <button type="button" className="lx-md-code-language is-button" aria-label={t`Code block language: ${currentLabel}. Click to change.`}>
          <span>{currentLabel}</span>
          <ChevronDown aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="lx-md-popover lx-md-language-popover w-56 p-0" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div className="lx-md-language-filter">
          <Input
            autoFocus
            controlSize="compact"
            placeholder={t`Filter languages`}
            aria-label={t`Filter languages`}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setActive(Math.min(active + 1, options.length - 1));
              } else if (event.key === "ArrowUp") {
                event.preventDefault();
                setActive(Math.max(active - 1, 0));
              } else if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                const option = options[active];
                if (option) pick(option.value);
              }
            }}
          />
        </div>
        <div ref={list} className="lx-md-language-list" role="listbox" aria-label={t`Language`}>
          {options.map((option, index) => (
            <div
              key={option.value}
              role="option"
              data-index={index}
              aria-selected={option.value === current}
              data-active={index === active || undefined}
              className="lx-md-language-option"
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(option.value)}
            >
              <span>{option.label}</span>
              {option.value === current && <Check aria-hidden="true" />}
            </div>
          ))}
          {!options.length && <div className="lx-md-language-empty" role="status">{t`No results`}</div>}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The fence title, edited in a popover and committed on Enter or when it closes. */
function CodeSettings({ title, onCommit }: { title: string; onCommit: (title: string) => void }) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(title);
  const commit = () => {
    if (draft !== title) onCommit(draft);
  };
  const close = (save: boolean) => {
    if (save) commit();
    setOpen(false);
  };
  const keys = useCommitKeys(() => close(true), () => close(false));
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        if (next) setDraft(title);
        else commit();
        setOpen(next);
      }}
    >
      <PopoverTrigger asChild>
        <IconButton size="compact" tooltip={false} label={t`Code block settings`}>
          <Settings2 aria-hidden="true" />
        </IconButton>
      </PopoverTrigger>
      <PopoverContent align="end" className="lx-md-popover w-64" onCloseAutoFocus={(event) => event.preventDefault()}>
        <div className="lx-md-properties">
          <Field label={t`Title`}>
            <Input
              autoFocus
              controlSize="compact"
              aria-label={t`Code block title`}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              {...keys}
            />
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * A rendered preview with its title attached, `w=<n>px` wide, resizable from
 * its left and right edges only; the new width is written when the drag ends.
 */
function PreviewSurface({ title, width, editable, onResize, children }: {
  title: string;
  width: number | null;
  editable: boolean;
  onResize: (width: number) => void;
  children: React.ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  const [dragWidth, setDragWidth] = useState<number | null>(null);
  const shown = dragWidth ?? width;
  const startDrag = (side: "left" | "right") => (event: ReactPointerEvent) => {
    const element = surface.current;
    if (!element) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = element.getBoundingClientRect().width;
    const available = element.parentElement?.getBoundingClientRect().width || Number.POSITIVE_INFINITY;
    let latest = startWidth;
    const move = (moveEvent: PointerEvent) => {
      const delta = (moveEvent.clientX - startX) * (side === "right" ? 2 : -2);
      latest = Math.round(Math.min(available, Math.max(MIN_PREVIEW_WIDTH, startWidth + delta)));
      setDragWidth(latest);
    };
    const end = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      setDragWidth(null);
      if (Math.abs(latest - startWidth) >= 1) onResize(latest);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
  };
  return (
    <div
      ref={surface}
      className="lx-md-code-preview"
      contentEditable={false}
      style={shown ? { width: `${shown}px` } as CSSProperties : undefined}
    >
      {title && <div className="lx-md-code-preview-title">{title}</div>}
      {children}
      {editable && (
        <>
          <span className="lx-md-resize-handle" data-side="left" onPointerDown={startDrag("left")} aria-hidden="true" />
          <span className="lx-md-resize-handle" data-side="right" onPointerDown={startDrag("right")} aria-hidden="true" />
        </>
      )}
    </div>
  );
}
