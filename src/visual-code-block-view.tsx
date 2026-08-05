/*
 * Reduced adaptation of inkeep/open-knowledge's CodeBlockView.tsx at commit
 * 9e8a00e24c6eaea110b546758664aad0e7ebab7e (GPL-3.0-or-later).
 */
import { useState } from "react";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Check, Code2, Copy, Eye, Trash2 } from "lucide-react";
import { MarkdownMermaid } from "./chat-markdown";

const TITLE_META = /(?:^|\s)title=(?:"([^"]*)"|'([^']*)'|(\S+))/;
const ALL_TITLE_META = /(?:^|\s)title=(?:"[^"]*"|'[^']*'|\S*)/g;

function readCodeTitle(meta: string): string {
  const match = TITLE_META.exec(meta);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}

function writeCodeTitle(meta: string, title: string): string {
  const rest = meta.replace(ALL_TITLE_META, " ").trim().replace(/\s+/g, " ");
  const safeTitle = title.replace(/["\r\n]/g, "");
  return [safeTitle ? `title="${safeTitle}"` : "", rest].filter(Boolean).join(" ");
}

const PREVIEW_THEME = `<style>:root{color-scheme:light dark;--background:light-dark(#fff,#171717);--foreground:light-dark(#1f2937,#f5f5f5);--card:light-dark(#fff,#222);--card-foreground:var(--foreground);--muted-foreground:light-dark(#6b7280,#a3a3a3);--border:light-dark(#e5e7eb,#404040);--primary:light-dark(#2563eb,#60a5fa);--chart-1:#3b82f6;--chart-2:#10b981;--chart-3:#f59e0b;--chart-4:#8b5cf6;--chart-5:#ef4444;--radius:8px}html,body{margin:0;background:var(--background);color:var(--foreground)}</style>`;

function previewDocument(code: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">${PREVIEW_THEME}</head><body>${code}</body></html>`;
}

export function VisualCodeBlockView({ node, updateAttributes, deleteNode }: NodeViewProps) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const code = node.textContent;
  const language = String(node.attrs.language ?? "").toLowerCase();
  // Lowercase ```mermaid fences are promoted to a MermaidFence jsxComponent
  // upstream; mixed-case or nonstandard fences stay code blocks for byte
  // fidelity, so render their diagram preview here.
  const mermaid = language === "mermaid";
  const previewable = language === "html"
    && /(?:^|\s)preview(?:\s|$)/.test(String(node.attrs.meta ?? ""));
  const [showPreview, setShowPreview] = useState(previewable);
  return (
    <NodeViewWrapper className="visual-code-block" role="group" aria-label="Code block">
      <div className="visual-code-block-controls" contentEditable={false}>
        <label>
          <span>Language</span>
          <input aria-label="Code language" value={String(node.attrs.language ?? "")} placeholder="Plain text" onChange={(event) => updateAttributes({ language: event.target.value.trim().split(/\s+/, 1)[0] || null })} />
        </label>
        <label className="visual-code-block-title">
          <span>Title</span>
          <input aria-label="Code title" value={readCodeTitle(String(node.attrs.meta ?? ""))} placeholder="Untitled" onChange={(event) => updateAttributes({ meta: writeCodeTitle(String(node.attrs.meta ?? ""), event.target.value) || null })} />
        </label>
        {previewable && <button type="button" aria-label={showPreview ? "Edit preview source" : "Show preview"} aria-pressed={showPreview} onClick={() => setShowPreview((value) => !value)}>
          {showPreview ? <Code2 aria-hidden="true" /> : <Eye aria-hidden="true" />}
          {showPreview ? "Source" : "Preview"}
        </button>}
        <button type="button" aria-label="Copy code" onClick={() => void navigator.clipboard.writeText(code).then(
          () => {
            setCopyStatus("copied");
            window.setTimeout(() => setCopyStatus("idle"), 1500);
          },
          () => {
            setCopyStatus("error");
            window.setTimeout(() => setCopyStatus("idle"), 2000);
          },
        )}>
          {copyStatus === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
          {copyStatus === "copied" ? "Copied" : copyStatus === "error" ? "Copy failed" : "Copy"}
        </button>
        <button type="button" className="danger" aria-label="Delete code block" onClick={deleteNode}>
          <Trash2 aria-hidden="true" />
          Delete
        </button>
      </div>
      {mermaid && (
        <div className="visual-markdown-mermaid-node" contentEditable={false} aria-label="Mermaid diagram preview">
          <MarkdownMermaid content={code} />
        </div>
      )}
      <pre className="visual-code-block-source" hidden={showPreview}>
        <NodeViewContent<"code"> as="code" aria-label="Code" role="textbox" aria-multiline="true" spellCheck={false} />
      </pre>
      {previewable && <iframe className="visual-code-preview" hidden={!showPreview} title="HTML code preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(code)} />}
    </NodeViewWrapper>
  );
}
