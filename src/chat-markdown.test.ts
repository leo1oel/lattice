import { describe, expect, it } from "vitest";
import { renderChatMarkdown } from "./chat-markdown";

describe("renderChatMarkdown", () => {
  it("renders the markdown the agent actually emits", () => {
    const html = renderChatMarkdown("Use **bold**, *italic*, and `code`.");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<em>italic</em>");
    expect(html).toContain("<code>code</code>");
  });

  it("keeps single newlines as line breaks, matching the old pre-wrap bubble", () => {
    expect(renderChatMarkdown("first\nsecond")).toContain("<br>");
  });

  it("renders inline and display math with KaTeX", () => {
    const inline = renderChatMarkdown("The loss $x^2$ falls.");
    expect(inline).toContain("katex");
    expect(inline).not.toContain("$x^2$");

    const display = renderChatMarkdown("$$\n\\sum_{i=1}^{n} x_i\n$$");
    expect(display).toContain("chat-math-block");
    expect(display).toContain("katex");
  });

  it("supports \\( \\) and \\[ \\] delimiters too", () => {
    expect(renderChatMarkdown("value \\(a+b\\) here")).toContain("katex");
    expect(renderChatMarkdown("\\[a+b\\]")).toContain("chat-math-block");
  });

  it("expands project macros so chat math matches the paper", () => {
    const html = renderChatMarkdown("$\\R^n$", { "\\R": "\\mathbb{R}" });
    // The macro resolved rather than rendering as an unknown control sequence.
    expect(html).toContain("katex");
    expect(html).not.toContain("undefined control sequence");
  });

  it("leaves dollar signs in prose alone", () => {
    const html = renderChatMarkdown("It costs $5 and then $10 more.");
    expect(html).not.toContain("katex");
    expect(html).toContain("$5");
    expect(html).toContain("$10");
  });

  it("does not treat dollars inside code as math", () => {
    const fenced = renderChatMarkdown("```sh\necho $HOME and $PATH\n```");
    expect(fenced).not.toContain("katex");
    expect(fenced).toContain("$HOME");

    const span = renderChatMarkdown("Run `cd $HOME` first.");
    expect(span).not.toContain("katex");
    expect(span).toContain("$HOME");
  });

  it("strips scripts and event handlers", () => {
    const html = renderChatMarkdown("<script>alert(1)</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });

  it("survives unterminated math while a reply is still streaming", () => {
    const html = renderChatMarkdown("The result is $x^2 + ");
    expect(html).toContain("$x^2");
  });

  it("does not throw on malformed TeX", () => {
    const html = renderChatMarkdown("$\\frac{1}{$");
    expect(typeof html).toBe("string");
  });
});
