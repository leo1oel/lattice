/**
 * A plugin's `message` result: CommonMark drawn as React elements, never as
 * HTML. Raw HTML in the source shows as its text, images as their
 * description (nothing loads from the network), and only http(s) links
 * open, in the browser.
 */
import { Fragment, useMemo, type ReactNode } from "react";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { Nodes } from "mdast";

const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

function render(node: Nodes, key: number | string, openUrl: (url: string) => void): ReactNode {
  const children = () => ("children" in node ? node.children.map((child, index) => render(child, index, openUrl)) : null);
  switch (node.type) {
    case "root": return <Fragment key={key}>{children()}</Fragment>;
    case "paragraph": return <p key={key}>{children()}</p>;
    case "heading": {
      const Heading = (["h3", "h3", "h4", "h5", "h6", "h6"] as const)[node.depth - 1];
      return <Heading key={key}>{children()}</Heading>;
    }
    case "text": return node.value;
    case "emphasis": return <em key={key}>{children()}</em>;
    case "strong": return <strong key={key}>{children()}</strong>;
    case "delete": return <del key={key}>{children()}</del>;
    case "inlineCode": return <code key={key}>{node.value}</code>;
    case "code": return <pre key={key}><code>{node.value}</code></pre>;
    case "blockquote": return <blockquote key={key}>{children()}</blockquote>;
    case "list": return node.ordered
      ? <ol key={key} start={node.start ?? undefined}>{children()}</ol>
      : <ul key={key}>{children()}</ul>;
    case "listItem": return <li key={key}>{children()}</li>;
    case "thematicBreak": return <hr key={key} />;
    case "break": return <br key={key} />;
    case "link": return isWebUrl(node.url)
      ? <a key={key} href={node.url} onClick={(event) => { event.preventDefault(); openUrl(node.url); }}>{children()}</a>
      : <Fragment key={key}>{children()}</Fragment>;
    case "image": return node.alt ?? "";
    case "html": return node.value;
    default: return <Fragment key={key}>{children()}</Fragment>;
  }
}

export function PluginMarkdown({ markdown, onOpenUrl }: { markdown: string; onOpenUrl: (url: string) => void }) {
  const tree = useMemo(() => fromMarkdown(markdown), [markdown]);
  return <div className="plugin-markdown">{render(tree, "root", onOpenUrl)}</div>;
}
