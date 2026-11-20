import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { conflictChoices, chooseSide, conflictSpots } from "./conflict-choices";

const MARKED = [
  "Intro.",
  "<<<<<<< This Mac",
  "The result never holds.",
  "||||||| Last sync",
  "The result holds.",
  "=======",
  "The result holds always.",
  ">>>>>>> Overleaf",
  "End.",
  "",
].join("\n");

function editor(doc: string) {
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  return new EditorView({ state: EditorState.create({ doc, extensions: [conflictChoices()] }), parent });
}

describe("inline conflict choices", () => {
  it.each([
    ["ours", "Intro.\nThe result never holds.\nEnd.\n"],
    ["theirs", "Intro.\nThe result holds always.\nEnd.\n"],
    ["both", "Intro.\nThe result never holds.\nThe result holds always.\nEnd.\n"],
  ] as const)("keeps %s, never the last synced text", (choice, expected) => {
    const view = editor(MARKED);
    const [spot] = conflictSpots(view.state.doc);
    expect(chooseSide(view, spot.from, choice)).toBe(true);
    expect(view.state.doc.toString()).toBe(expected);
    view.destroy();
  });

  it("draws one bar of three choices per spot, and clicking one resolves that spot only", () => {
    const view = editor(MARKED + MARKED);
    const bars = view.dom.querySelectorAll(".cm-conflict-choices");
    expect(bars).toHaveLength(2);
    expect([...bars[0].querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Keep mine", "Keep theirs", "Keep both"]);
    (bars[1].querySelector("[data-choice=theirs]") as HTMLButtonElement).click();
    const text = view.state.doc.toString();
    expect(text.match(/<<<<<<</g)).toHaveLength(1);
    expect(text.endsWith("Intro.\nThe result holds always.\nEnd.\n")).toBe(true);
    expect(view.dom.querySelectorAll(".cm-conflict-choices")).toHaveLength(1);
    view.destroy();
  });

  it("removes a spot whose kept side is empty, line break and all, and leaves a file without markers alone", () => {
    const view = editor("a\n<<<<<<< This Mac\n=======\ngone\n>>>>>>> Overleaf\nb");
    chooseSide(view, conflictSpots(view.state.doc)[0].from, "ours");
    expect(view.state.doc.toString()).toBe("a\nb");
    expect(view.dom.querySelector(".cm-conflict-choices")).toBeNull();
    view.destroy();
  });

  it("tints each side apart", () => {
    const view = editor(MARKED);
    const classes = [...view.contentDOM.querySelectorAll(".cm-line")].map((line) => line.className.match(/cm-conflict-\w+/)?.[0] ?? "");
    expect(classes).toEqual(["", "cm-conflict-marker", "cm-conflict-ours", "cm-conflict-marker", "cm-conflict-base", "cm-conflict-marker", "cm-conflict-theirs", "cm-conflict-marker", "", ""]);
    view.destroy();
  });
});
