import { describe, expect, it } from "vitest";
import { expandSnippetPlaceholders, nextSnippetStop, previousSnippetStop } from "./snippet-placeholders";

describe("snippet placeholders", () => {
  it("expands numbered placeholders and preserves order", () => {
    const expanded = expandSnippetPlaceholders("\\caption{${1:Caption}} \\label{${2:fig:name}}");
    expect(expanded.text).toBe("\\caption{Caption} \\label{fig:name}");
    expect(expanded.stops).toEqual([
      { from: expanded.text.indexOf("Caption"), to: expanded.text.indexOf("Caption") + "Caption".length },
      { from: expanded.text.indexOf("fig:name"), to: expanded.text.indexOf("fig:name") + "fig:name".length },
    ]);
  });

  it("finds the next stop after the cursor", () => {
    const stops = [{ from: 2, to: 5 }, { from: 10, to: 14 }];
    expect(nextSnippetStop(stops, 0, 0)).toEqual({ from: 2, to: 5 });
    expect(nextSnippetStop(stops, 5, 0)).toEqual({ from: 10, to: 14 });
  });

  it("finds the previous stop before the cursor", () => {
    const stops = [{ from: 2, to: 5 }, { from: 10, to: 14 }];
    expect(previousSnippetStop(stops, 12, 0)).toEqual({ from: 2, to: 5 });
    expect(previousSnippetStop(stops, 4, 0)).toEqual({ from: 2, to: 5 });
  });
});
