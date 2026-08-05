/**
 * React NodeView for the visual-mode code block.
 *
 * Visual design — zero permanent chrome: the code body renders solo, with a
 * hover/selection-revealed chrome bar floating above the block edge that
 * carries the language picker, edit-source, preview toggle, settings, Ask AI,
 * copy, and delete affordances. Mirrors the JsxComponentView chrome pattern
 * (precedent #30) so codeblocks compose visually with other rich blocks.
 */

import { composeSelectionPrompt } from '@ok-core';
import { Trans, useLingui } from '@ok-app/shims/lingui-react-macro';
import type { NodeViewProps } from '@tiptap/core';
import { NodeViewContent, NodeViewWrapper } from '@tiptap/react';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Check,
  ChevronDown,
  Copy,
  Eye,
  EyeOff,
  Settings2,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { useTheme } from '@ok-app/shims/next-themes';
import { useEffect, useId, useRef, useState } from 'react';
import { emitOpenAskAiComposer } from '@ok-app/components/ask-ai-composer-events';
import { requestActiveTerminalInput } from '@ok-app/components/handoff/terminal-input-events';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@ok-app/components/ui/command';
import { Input } from '@ok-app/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@ok-app/components/ui/popover';
import { useIsEmbedded } from '@ok-app/hooks/use-is-embedded';
import { useColorThemeEpoch } from '@ok-app/lib/color-theme-epoch';
import { cn } from '@ok-app/lib/utils';
import { docNameToRelativePath } from '@ok-app/lib/workspace-paths';
import { OPT_OUT_ATTR } from '../clipboard/index.ts';
import { PreviewBlockedNotice } from '../components/PreviewBlockedNotice';
import { ResizeHandles } from '../components/ResizeHandles.tsx';
import { MermaidView } from '../components/Mermaid.tsx';
import { serializeWysiwygSelection } from '../edit-with-ai-selection';
import { CODE_BLOCK_LANGUAGES, normalizeCodeLanguage } from './code-block-languages';
import {
  addMetaToken,
  getMetaTitle,
  PREVIEWABLE_LANGUAGES,
  parsePreviewAlign,
  parsePreviewWidth,
  removeMetaToken,
  setMetaKeyValue,
  setMetaTitle,
  shouldShowPreview,
} from './code-block-meta';
import { getEditorDocName } from './doc-context';
import {
  buildPreviewIframeHeader,
  buildPreviewThemeMessage,
  type PreviewBlockedRequest,
  type PreviewTheme,
  parsePreviewCspViolationMessage,
} from './preview-iframe-header';

const PLAIN_TEXT = 'plaintext';

/**
 * Read the reader's resolved app theme from the `<html>.dark` class that
 * `next-themes` maintains. The class is set pre-paint, so this is accurate
 * synchronously — including on the first render before `useTheme()` resolves.
 */
function readAppTheme(): PreviewTheme {
  return typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}

function useCursorInside(editor: NodeViewProps['editor'], getPos: NodeViewProps['getPos']) {
  const [inside, setInside] = useState(false);
  useEffect(() => {
    const compute = () => {
      const pos = typeof getPos === 'function' ? getPos() : undefined;
      if (typeof pos !== 'number' || pos < 0 || pos > editor.state.doc.content.size) return;
      const node = editor.state.doc.nodeAt(pos);
      if (!node) return;
      const { from, to } = editor.state.selection;
      const start = pos;
      const end = pos + node.nodeSize;
      // Selection overlaps this node when from < end AND to > start.
      const next = from < end && to > start;
      // Equality guard: avoid scheduling a state update when the cursor-inside
      // bit didn't actually flip — keeps re-render cost flat across remote
      // peer keystrokes inside this block.
      setInside((prev) => (prev === next ? prev : next));
    };
    compute();
    // `selectionUpdate` alone is sufficient — it fires for every selection
    // change including doc mutations that shift the cursor. The previously
    // wired `transaction` listener overlapped (every selection-changing tx
    // fires both) AND woke every mounted code-block on remote-peer ticks
    // under `extension-collaboration`.
    editor.on('selectionUpdate', compute);
    return () => {
      if (!editor.isDestroyed) editor.off('selectionUpdate', compute);
    };
  }, [editor, getPos]);
  return inside;
}

export function CodeBlockView({ node, updateAttributes, editor, getPos, selected }: NodeViewProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const copyResetRef = useRef<number | null>(null);
  const previewWrapperRef = useRef<HTMLDivElement | null>(null);
  const previewFrameRef = useRef<HTMLIFrameElement | null>(null);
  const codePreRef = useRef<HTMLPreElement | null>(null);
  const [remoteCursorInside, setRemoteCursorInside] = useState(false);
  // Requests the preview iframe's CSP (or the host's security layer) blocked,
  // reported over postMessage. `null` until the iframe reports a violation;
  // reset on every (re)load since a code/policy edit re-evaluates the policy.
  const [blockedRequests, setBlockedRequests] = useState<{
    blocked: PreviewBlockedRequest[];
    truncated: boolean;
  } | null>(null);
  // The reader's resolved app theme. `next-themes`' `resolvedTheme` is the
  // re-render trigger; the `<html>.dark` class is the synchronous source of
  // truth (set pre-paint), so `appTheme` is correct even on the first render
  // before `resolvedTheme` resolves.
  const { resolvedTheme } = useTheme();
  const appTheme: PreviewTheme =
    resolvedTheme === 'dark' || resolvedTheme === 'light' ? resolvedTheme : readAppTheme();
  // The color-theme axis has no React signal of its own — see `useColorThemeEpoch`.
  const colorThemeEpoch = useColorThemeEpoch();
  // Freeze the complete iframe header, including live palette tokens, at
  // NodeView mount. ReactNodeViewRenderer rerenders an unchanged code block
  // when an adjacent insertion shifts getPos(); rebuilding the header there
  // can assign a new srcDoc and make WebKit reload an otherwise unchanged
  // iframe. Theme and palette updates already use postMessage below.
  const [previewHeader] = useState(() => buildPreviewIframeHeader(readAppTheme()));
  const rawLanguage = (node.attrs.language as string | null) ?? null;
  const rawMeta = (node.attrs.meta as string | null) ?? null;
  const title = getMetaTitle(rawMeta);
  // Settings popover state — opens via the chrome's gear button, hosts
  // the title input and is the natural home for future
  // node-level knobs that don't fit the language-picker / icon-button
  // chrome surface. Mirrors `PropPanel`'s "Advanced" section in spirit
  // — single trigger, popover-shaped, holds the rarely-used knobs that
  // would otherwise crowd the always-visible chrome.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [titleDraft, setTitleDraft] = useState(title ?? '');
  // Ask AI on this code block. Chrome-hosted (not the bubble menu),
  // because the block isn't a text selection — the whole fence is the
  // context we want to hand to the agent. Hidden inside an embedded agent
  // host, same as the text bubble menu's Ask AI button.
  const isEmbedded = useIsEmbedded();
  // Hovered state — the html preview iframe consumes 100% of the block's
  // pointer events, so the CSS `:hover` selector never fires on the wrapper.
  // Mirror mouseenter/mouseleave into a data attribute so the chrome-reveal
  // rule (`.ok-codeblock[data-hovered="true"] > .ok-codeblock-chrome`) still
  // works over the iframe. React's synthetic mouseenter/leave fire on the
  // wrapper regardless of which descendant consumes pointer events.
  const [hovered, setHovered] = useState(false);
  // React's `useId` gives each NodeView instance its own DOM ids so a doc
  // with multiple code blocks doesn't collide on `htmlFor` ↔ `id`
  // association (clicking one block's title label would otherwise focus a
  // sibling block's input) and stays WCAG 4.1.1-compliant when popovers
  // briefly overlap during outside-click teardown. Two ids per block:
  //   - `titleInputId` → input ↔ label
  //   - `titleHelpId`  → input ↔ help paragraph via `aria-describedby`,
  //     so AT users hear the round-trip caveat alongside the field name.
  // `useId` is React 18+'s SSR-safe form.
  const baseId = useId();
  const titleInputId = `${baseId}-title-input`;
  const titleHelpId = `${baseId}-title-help`;
  // Mirror `rawMeta` into a ref so the resize commit can read the latest
  // value without re-listing rawMeta in stable callbacks. React Compiler
  // rejects ref mutation during render, so sync via an effect.
  const rawMetaRef = useRef(rawMeta);
  useEffect(() => {
    rawMetaRef.current = rawMeta;
  }, [rawMeta]);
  const normalized = normalizeCodeLanguage(rawLanguage);
  const currentLabel = !rawLanguage
    ? t`Plain`
    : (CODE_BLOCK_LANGUAGES.find((l) => l.value === normalized)?.label ?? rawLanguage);
  const previewRenderable = normalized ? PREVIEWABLE_LANGUAGES.has(normalized) : false;
  const previewActive = shouldShowPreview(normalized, rawMeta);
  const isMermaidPreview = normalized === 'mermaid';
  const previewWidth = previewActive ? parsePreviewWidth(rawMeta) : null;
  const previewAlign = parsePreviewAlign(rawMeta);
  // A preview normally replaces its source, but hiding the PM contentDOM would
  // also hide an Overleaf collaborator's cursor. Reveal the source while a
  // remote-caret widget is inside this block, then collapse it again when the
  // collaborator moves away.
  const codeVisible = !previewActive || remoteCursorInside;

  useEffect(() => {
    const pre = codePreRef.current;
    if (!pre) return;
    const updateRemoteCursor = () => {
      setRemoteCursorInside(Boolean(pre.querySelector('.visual-overleaf-caret')));
    };
    updateRemoteCursor();
    const observer = new MutationObserver(updateRemoteCursor);
    observer.observe(pre, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
    },
    [],
  );

  const editable = editor.isEditable;
  const cursorInside = useCursorInside(editor, getPos);

  // Re-skin the live preview when the reader toggles the app theme —
  // `postMessage` only, no `srcDoc` rebuild, so the iframe never reloads.
  // The iframe `onLoad` handler covers the reverse: re-pushing the current
  // theme after a reload. `colorThemeEpoch` is in the deps because switching
  // between two palettes of the same kind (Dracula -> Monokai) never changes
  // `appTheme`, and the forwarded tokens must still follow.
  // biome-ignore lint/correctness/useExhaustiveDependencies: colorThemeEpoch is a signal-only dependency — its bump re-runs this effect so the live iframe re-reads the palette's tokens; it is intentionally not referenced in the body.
  useEffect(() => {
    previewFrameRef.current?.contentWindow?.postMessage(buildPreviewThemeMessage(appTheme), '*');
  }, [appTheme, colorThemeEpoch]);

  // Filter messages to this block's iframe so a sibling preview cannot surface
  // its CSP violations here.
  useEffect(() => {
    function onMessage(e: MessageEvent) {
      if (e.source !== previewFrameRef.current?.contentWindow) return;
      // The iframe posts a cumulative, deduped snapshot each debounce window —
      // replace state with the latest (most complete) report.
      const violation = parsePreviewCspViolationMessage(e.data);
      if (violation !== null) setBlockedRequests(violation);
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const handleCopy = () => {
    const text = node.textContent;
    // `writeText` returns a Promise; gate the success-state flip on actual
    // resolution so a permissions denial or insecure-context rejection
    // (NotAllowedError, returned async) doesn't paint a misleading
    // checkmark over a no-op write.
    const flipSuccess = () => {
      setCopied(true);
      if (copyResetRef.current !== null) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopied(false), 1200);
    };
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(flipSuccess, () => {
          /* permission denial / insecure context — leave the icon as-is */
        });
      }
    } catch {
      /* sync throw (navigator absent in test env) — fail silent */
    }
  };

  const handleDelete = () => {
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (typeof pos !== 'number') return;
    try {
      editor.chain().focus().setNodeSelection(pos).deleteSelection().run();
    } catch (err) {
      // Concurrent remote-peer edits or Observer B re-parse can shift `pos`
      // between getPos() and the chain run, producing a RangeError. Mirrors
      // the JsxComponentView.deleteNode pattern — classify + log instead of
      // letting the error boundary catch what's actually a benign race.
      if (!(err instanceof RangeError)) throw err;
      console.warn('[CodeBlockView] delete failed — position race', err);
    }
  };

  const handleTogglePreview = () => {
    const next = previewActive
      ? addMetaToken(rawMeta, 'source')
      : removeMetaToken(rawMeta, 'source');
    updateAttributes({ meta: next });
  };

  // Commit once when the settings popover closes. Updating the code-block
  // attrs on every keystroke can rebuild this NodeView after the host echoes
  // the serialized Markdown, which unmounts the portal and makes the title
  // field close after every character.
  const commitTitle = (raw: string) => {
    const newMeta = setMetaTitle(rawMeta, raw.length > 0 ? raw : null);
    if (newMeta === rawMeta) return;
    updateAttributes({ meta: newMeta });
  };

  const handleSettingsOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      setTitleDraft(title ?? '');
      setSettingsOpen(true);
      return;
    }
    commitTitle(titleDraft);
    setSettingsOpen(false);
  };

  // Preview blocks resize horizontally only. Mermaid derives its height from
  // the diagram, while HTML uses a fixed scrolling viewport.
  const handleResizeEnd = (size: { width: number; height: number }) => {
    const w = `${Math.round(size.width)}px`;
    const next = setMetaKeyValue(rawMetaRef.current, 'w', w);
    const viewport = previewWrapperRef.current?.closest<HTMLElement>('.editor-doc-scroll') ?? null;
    const scrollTop = viewport?.scrollTop ?? 0;
    updateAttributes({ meta: next });
    // In split mode the source echo and Mermaid's responsive reflow can land
    // in the same frame. Preserve the visual pane's viewport so the metadata
    // commit cannot expose the editor's stale top-of-document selection.
    if (viewport) {
      queueMicrotask(() => {
        viewport.scrollTop = scrollTop;
      });
      window.requestAnimationFrame(() => {
        viewport.scrollTop = scrollTop;
      });
    }
  };

  const setPreviewAlign = (align: 'left' | 'center' | 'right') => {
    updateAttributes({ meta: setMetaKeyValue(rawMetaRef.current, 'align', align) });
  };

  const titleStrip = title ? (
    <div
      className="ok-codeblock-title"
      contentEditable={false}
      data-testid="ok-codeblock-title"
      title={title}
    >
      <span className="ok-codeblock-title-text">{title}</span>
    </div>
  ) : null;

  return (
    <NodeViewWrapper
      className="ok-codeblock relative my-3"
      data-language={rawLanguage ?? undefined}
      data-cursor-inside={cursorInside ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      data-preview={previewActive ? 'true' : undefined}
      data-preview-align={previewActive ? previewAlign : undefined}
      data-code-visible={codeVisible ? 'true' : 'false'}
      data-hovered={hovered ? 'true' : undefined}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* A source title sits above its pre. Preview titles live inside the
          resizable preview card below, so both surfaces share one width. */}
      {!previewActive ? titleStrip : null}

      {previewActive ? (
        // biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required so resize-handle drags don't bubble into PM
        <div
          ref={previewWrapperRef}
          className={cn(
            'ok-codeblock-preview',
            isMermaidPreview ? 'ok-codeblock-preview--mermaid' : 'ok-codeblock-preview--html',
            codeVisible ? 'ok-codeblock-preview--with-code' : 'ok-codeblock-preview--solo',
          )}
          data-align={previewAlign}
          contentEditable={false}
          style={{
            ...(previewWidth ? { width: previewWidth } : {}),
          }}
          // PM treats mousedown inside contentEditable as a selection drag.
          // The resize handles themselves stopPropagation in ResizeHandles,
          // but the wrapper also needs it so click-into-iframe selection
          // attempts don't trip PM's drag.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {titleStrip}
          {isMermaidPreview ? (
            <div
              role="group"
              aria-label={t`Mermaid preview`}
              className="ok-codeblock-preview-content flex w-full min-h-0 items-stretch justify-stretch"
            >
              <MermaidView chart={node.textContent} className="w-full rounded-none border-0" />
            </div>
          ) : (
            <iframe
              title={t`HTML preview`}
              ref={previewFrameRef}
            // `allow-scripts` runs the embedded JS; omitting `allow-same-origin`
            // forces a null origin so the iframe cannot reach the parent doc,
            // its cookies, or the auth-bearing fetch surface.
            sandbox="allow-scripts"
            // `about:srcdoc` inherits the embedder's URL as the Referer for
            // any `<img>` / `fetch` request the renderer makes — leaking the
            // doc path. The CSP above blocks the requests outright, but
            // `no-referrer` is cheap defense-in-depth.
            referrerPolicy="no-referrer"
            // The header is frozen at mount, so theme/palette changes never
            // land here (they re-skin via postMessage). Only edited code text
            // or a genuine NodeView remount can now reload the iframe.
            srcDoc={previewHeader + node.textContent}
            className="ok-codeblock-preview-frame"
            // Re-push the resolved theme after every (re)load so a reload from
            // a code/policy edit cannot leave the iframe on a stale baked theme.
            // Also clear any prior blocked-request notice — the reloaded iframe
            // re-evaluates the policy and will re-report from scratch.
              onLoad={() => {
                setBlockedRequests(null);
                previewFrameRef.current?.contentWindow?.postMessage(
                  buildPreviewThemeMessage(appTheme),
                  '*',
                );
              }}
            />
          )}
          <ResizeHandles
            targetRef={previewWrapperRef}
            handles={['l', 'r']}
            bounds={{
              minWidth: 192,
              maxWidth: Math.round(window.innerWidth * 0.9),
            }}
            // Live: paint the new size on the wrapper for smooth feedback.
            onResize={(size) => {
              const el = previewWrapperRef.current;
              if (!el) return;
              el.style.width = `${size.width}px`;
            }}
            // Commit only width; vertical size is content-policy driven.
            onResizeEnd={handleResizeEnd}
          />
        </div>
      ) : null}

      {previewActive && !isMermaidPreview && blockedRequests ? (
        <PreviewBlockedNotice
          blocked={blockedRequests.blocked}
          truncated={blockedRequests.truncated}
          onDismiss={() => setBlockedRequests(null)}
        />
      ) : null}

      {/* `<pre>` is ALWAYS mounted so PM's contentDOM has a stable host — we
          hide via CSS only (`data-code-visible="false"`) rather than
          conditional render. Keeps caret stability, undo history, and any
          decorations from churning when the user collapses the code. */}
      <pre
        ref={codePreRef}
        className={cn(
          'ok-codeblock-pre m-0 overflow-x-auto px-5 py-4 font-mono text-sm leading-relaxed',
          previewActive && codeVisible ? 'rounded-b-lg' : null,
          !previewActive ? 'rounded-lg' : null,
        )}
        // Hide from AT when collapsed — visually-zero content still in the
        // accessibility tree gets announced by screen readers (WCAG 1.3.1).
        // `aria-hidden` doesn't affect DOM existence, so PM's contentDOM
        // contract holds.
        aria-hidden={!codeVisible || undefined}
      >
        <NodeViewContent<'code'>
          as="code"
          style={{ whiteSpace: 'break-spaces' }}
          className={cn(
            'hljs block break-words bg-transparent p-0',
            rawLanguage ? `language-${rawLanguage}` : undefined,
          )}
        />
      </pre>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation required inside PM NodeView */}
      <div
        className="ok-codeblock-chrome"
        contentEditable={false}
        onMouseDown={(e) => e.stopPropagation()}
        {...{ [OPT_OUT_ATTR]: 'true' }}
      >
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              disabled={!editable}
              className="ok-codeblock-chrome-btn ok-codeblock-chrome-lang"
              aria-label={t`Code block language: ${currentLabel}. Click to change.`}
            >
              <span>{currentLabel}</span>
              {editable ? <ChevronDown className="size-3 opacity-60" aria-hidden="true" /> : null}
            </button>
          </PopoverTrigger>
          <PopoverContent align="end" sideOffset={6} className="w-56 p-0">
            <Command
              filter={(value, search) => {
                if (!search) return 1;
                return value.toLowerCase().includes(search.toLowerCase()) ? 1 : 0;
              }}
            >
              <CommandInput placeholder={t`Filter languages`} />
              <CommandList>
                <CommandEmpty>{t`No language match.`}</CommandEmpty>
                <CommandGroup>
                  {CODE_BLOCK_LANGUAGES.map((lang) => {
                    // The Plain entry is active when the fence has no language
                    // (`null`) OR the user explicitly typed `plaintext` /
                    // an alias that normalizes to it — without the second
                    // branch, ` ```plaintext ` fences show no checkmark.
                    const isActive =
                      lang.value === PLAIN_TEXT
                        ? !rawLanguage || normalized === PLAIN_TEXT
                        : normalized === lang.value;
                    return (
                      <CommandItem
                        key={lang.value}
                        value={`${lang.label} ${lang.value} ${lang.aliases?.join(' ') ?? ''}`}
                        onSelect={() => {
                          const next = lang.value === PLAIN_TEXT ? null : lang.value;
                          updateAttributes({ language: next });
                          setOpen(false);
                          editor.commands.focus();
                        }}
                      >
                        <span className="flex-1">{lang.label}</span>
                        {isActive ? <Check className="size-3.5" aria-hidden="true" /> : null}
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>

        {editable && previewRenderable ? (
          <button
            type="button"
            className="ok-codeblock-chrome-btn"
            data-active={previewActive ? 'true' : undefined}
            aria-pressed={previewActive}
            aria-label={
              previewActive
                ? isMermaidPreview
                  ? t`Hide Mermaid preview`
                  : t`Hide HTML preview`
                : isMermaidPreview
                  ? t`Show Mermaid preview`
                  : t`Show HTML preview`
            }
            onClick={handleTogglePreview}
          >
            {previewActive ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        ) : null}

        {editable && previewActive ? (
          <>
            {([
              ['left', t`Align preview left`, AlignLeft],
              ['center', t`Align preview center`, AlignCenter],
              ['right', t`Align preview right`, AlignRight],
            ] as const).map(([align, label, Icon]) => (
              <button
                key={align}
                type="button"
                className="ok-codeblock-chrome-btn"
                data-active={previewAlign === align ? 'true' : undefined}
                aria-label={label}
                aria-pressed={previewAlign === align}
                onClick={() => setPreviewAlign(align)}
              >
                <Icon className="size-3.5" aria-hidden="true" />
              </button>
            ))}
          </>
        ) : null}

        {editable ? (
          <Popover open={settingsOpen} onOpenChange={handleSettingsOpenChange}>
            <PopoverTrigger asChild>
              <button
                type="button"
                className="ok-codeblock-chrome-btn"
                data-active={title ? 'true' : undefined}
                aria-label={t`Code block settings`}
              >
                <Settings2 className="size-3.5" aria-hidden="true" />
              </button>
            </PopoverTrigger>
            <PopoverContent align="end" sideOffset={6} className="w-64 p-3">
              <div className="flex flex-col gap-1.5">
                <label
                  htmlFor={titleInputId}
                  className="text-2xs font-mono uppercase tracking-wide text-muted-foreground"
                >
                  <Trans>Title</Trans>
                </label>
                <Input
                  id={titleInputId}
                  type="text"
                  value={titleDraft}
                  placeholder={t`e.g. server.ts`}
                  data-testid="ok-codeblock-title-input"
                  // Link the help paragraph below so screen readers announce
                  // the round-trip caveat after the field label.
                  aria-describedby={titleHelpId}
                  onChange={(e) => setTitleDraft(e.target.value)}
                  onKeyDown={(e) => {
                    // Match the prior live-commit behavior: both Enter and
                    // Escape keep what was typed, but commit it only once so
                    // the input remains mounted throughout editing.
                    if (e.key === 'Enter' || e.key === 'Escape') {
                      e.preventDefault();
                      commitTitle(e.currentTarget.value);
                      setSettingsOpen(false);
                    }
                  }}
                  className="h-8"
                />
                <p id={titleHelpId} className="text-2xs text-muted-foreground">
                  <Trans>
                    Shows above the code body. Round-trips as `title="..."` in markdown.
                  </Trans>
                </p>
              </div>
            </PopoverContent>
          </Popover>
        ) : null}

        {isEmbedded ? null : (
          <button
            type="button"
            className="ok-codeblock-chrome-btn"
            aria-label={t`Ask AI about this code block`}
            data-testid="ok-codeblock-ask-ai-btn"
            onClick={() => {
              // Make this code block the WYSIWYG selection so
              // `serializeWysiwygSelection` emits the canonical fenced form
              // (the code-block-fidelity extension's `fenceLength` outlasts
              // any inner backtick run). `composeSelectionPrompt` then
              // decides inline vs locus against the encoded-URL budget; the
              // dispatch routes through `SessionsHost` which pastes
              // to a live PTY or launches a fresh Claude tab.
              const docName = getEditorDocName(editor);
              const pos = typeof getPos === 'function' ? getPos() : undefined;
              if (typeof pos !== 'number') return;
              try {
                editor.commands.setNodeSelection(pos);
              } catch (err) {
                // Mirrors `handleDelete`'s classification — concurrent remote
                // edits or Observer B re-parse can shift `pos` between
                // getPos() and setNodeSelection, producing a RangeError. The
                // block has moved or vanished, so there is nothing to Ask AI
                // about; keep the error off the boundary for benign races.
                if (!(err instanceof RangeError)) throw err;
                console.warn('[CodeBlockView] Ask AI failed — position race', err);
                return;
              }
              const selectionMarkdown = serializeWysiwygSelection(editor);
              requestAnimationFrame(() => {
                if (docName === null || !selectionMarkdown.trim()) {
                  emitOpenAskAiComposer();
                  return;
                }
                requestActiveTerminalInput(
                  composeSelectionPrompt({
                    relativePath: docNameToRelativePath(docName),
                    instruction: '',
                    selectionMarkdown,
                    target: 'claude-code',
                  }),
                  // A composed ask, so a fresh session runs it — matching the
                  // fresh-CLI behavior this surface has always had.
                  { submit: true },
                );
              });
            }}
          >
            <Sparkles className="size-3.5" aria-hidden="true" />
          </button>
        )}

        <button
          type="button"
          className="ok-codeblock-chrome-btn"
          aria-label={copied ? t`Copied` : t`Copy code`}
          onClick={handleCopy}
        >
          {copied ? (
            <Check className="size-3.5" aria-hidden="true" />
          ) : (
            <Copy className="size-3.5" aria-hidden="true" />
          )}
        </button>

        {editable ? (
          <button
            type="button"
            className="ok-codeblock-chrome-btn ok-codeblock-chrome-btn--delete"
            aria-label={t`Delete code block`}
            onClick={handleDelete}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </NodeViewWrapper>
  );
}
