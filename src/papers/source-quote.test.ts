import { describe, expect, it } from "vitest";
import { findSourceQuote, sourceQuoteDomRange } from "./source-quote";

describe("findSourceQuote", () => {
  it("retains PDF line breaks and Markdown block boundaries when finding a DOM range", () => {
    const root = document.createElement("div");
    root.innerHTML = "<p>Other text</p><p>A <b>training</b> algo-<br>rithm works.</p><p>Ends here.</p>";
    const range = sourceQuoteDomRange(root, "training algorithm", "Ends here.");
    expect(range?.startContainer.textContent).toBe("training");
    expect(range?.endContainer.textContent).toBe("Ends here.");
    expect(range?.toString()).toBe("training algo-rithm works.Ends here.");
    expect(sourceQuoteDomRange(root, "training algorithm", "Missing end")).toBeNull();
  });

  it("returns original UTF-16 offsets after asymmetric PDF text normalization", () => {
    const text = "😀 The efﬁcient algo-\n  rithm uses   less space. Tail";
    const result = findSourceQuote(text, "The efficient", "less space.");
    expect(result).toEqual({
      from: text.indexOf("The"),
      to: text.indexOf("less space.") + "less space.".length,
    });
    expect(text.slice(result!.from, result!.to)).toBe("The efﬁcient algo-\n  rithm uses   less space.");
  });

  it("allows overlapping boundary snippets", () => {
    expect(findSourceQuote("prefix abcdef suffix", "abcd", "cdef")).toEqual({ from: 7, to: 13 });
  });

  it("rejects ambiguous ranges and does not remove ordinary hyphens", () => {
    expect(findSourceQuote("start end / start end", "start", "end")).toBeNull();
    expect(findSourceQuote("co-operate", "cooperate", "cooperate")).toBeNull();
  });

  it("returns null for missing or empty boundaries", () => {
    expect(findSourceQuote("some text", "some", "absent")).toBeNull();
    expect(findSourceQuote("some text", "", "text")).toBeNull();
  });
});
