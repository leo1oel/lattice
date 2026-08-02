import { useEffect, useMemo, useRef } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { renderMarkdown } from "./chat-markdown-renderer";
import "katex/dist/katex.min.css";

export function ChatMarkdown({ text, macros, className, breaks }: {
  text: string;
  macros?: Record<string, string>;
  className?: string;
  breaks?: boolean;
}) {
  const html = useMemo(
    () => renderMarkdown(text, macros ?? {}, { breaks: breaks ?? true }),
    [text, macros, breaks],
  );
  const ref = useRef<HTMLDivElement | null>(null);

  // Links must leave the webview, not navigate the app out of existence.
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const onClick = (event: MouseEvent) => {
      const anchor = (event.target as HTMLElement | null)?.closest?.("a");
      const href = anchor?.getAttribute("href");
      if (!href) return;
      event.preventDefault();
      if (/^https?:\/\//i.test(href)) void openUrl(href).catch(() => undefined);
    };
    container.addEventListener("click", onClick);
    return () => container.removeEventListener("click", onClick);
  }, []);

  return (
    <div
      ref={ref}
      className={className ? `chat-markdown ${className}` : "chat-markdown"}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
