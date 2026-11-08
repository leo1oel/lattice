import { act, cleanup, fireEvent, render, renderHook, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";

import { APPEARANCE_KEY, type AppearanceSettings, loadAppearance } from "./app-settings";
import { EditorFontSettingsGroups } from "./editor-font-settings";
import { cssFontFamily, editorFontStack, normalizeFontName, normalizeLineHeight } from "./editor-fonts";
import { useAppearance } from "./use-appearance";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ setZoom: vi.fn().mockResolvedValue(undefined) }),
}));

const TOKENS = ["--source-font", "--source-line-height", "--prose-font", "--prose-font-size", "--prose-line-height"];
const token = (name: string) => document.documentElement.style.getPropertyValue(name);

beforeEach(() => {
  localStorage.clear();
  vi.mocked(invoke).mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  for (const name of TOKENS) document.documentElement.style.removeProperty(name);
});

describe("editor font preferences", () => {
  it("default to today's editors", () => {
    expect(loadAppearance()).toMatchObject({
      editorFontSize: 14, sourceFont: "", sourceLineHeight: 1.6, proseFont: "", proseFontSize: 14, proseLineHeight: 1.7,
    });
  });

  it("normalize what storage holds", () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({
      sourceFont: "  Fira \"Code\";} body{ ", sourceLineHeight: 9, proseFont: 42, proseFontSize: 3, proseLineHeight: 1.83, editorFontSize: 40,
    }));
    expect(loadAppearance()).toMatchObject({
      sourceFont: "Fira Code body", sourceLineHeight: 2.4, proseFont: "", proseFontSize: 10, proseLineHeight: 1.85, editorFontSize: 28,
    });
  });

  it("write a face as one family that falls back to the default stack", () => {
    expect(cssFontFamily("ui-monospace")).toBe("ui-monospace");
    expect(cssFontFamily("Atkinson Hyperlegible")).toBe("\"Atkinson Hyperlegible\"");
    expect(editorFontStack("OpenDyslexic", "--reading-font")).toBe("\"OpenDyslexic\", var(--reading-font)");
    expect(normalizeFontName("a\\b<c>\n")).toBe("abc");
    expect(normalizeLineHeight("x", 1.7)).toBe(1.7);
    expect(normalizeLineHeight(1.0, 1.7)).toBe(1.2);
  });
});

describe("applying editor fonts", () => {
  it("leaves every token to the stylesheet until the writer chooses, then sets it live", () => {
    const resize = vi.fn();
    window.addEventListener("resize", resize);
    const { result } = renderHook(() => useAppearance());
    for (const name of TOKENS) expect(token(name)).toBe("");
    // Mounting changes nothing the editors measured.
    expect(resize).not.toHaveBeenCalled();

    act(() => result.current.setAppearance({
      ...result.current.appearance, sourceFont: "Atkinson Hyperlegible", sourceLineHeight: 2, proseFont: "ui-serif", proseFontSize: 18, proseLineHeight: 1.9,
    }));
    expect(token("--source-font")).toBe("\"Atkinson Hyperlegible\", var(--editor-font)");
    expect(token("--source-line-height")).toBe("2");
    expect(token("--prose-font")).toBe("ui-serif, var(--reading-font)");
    expect(token("--prose-font-size")).toBe("18px");
    expect(token("--prose-line-height")).toBe("1.9");
    // CodeMirror and the visual editor measure again.
    expect(resize).toHaveBeenCalled();

    act(() => result.current.setAppearance({
      ...result.current.appearance, sourceFont: "", sourceLineHeight: 1.6, proseFont: "", proseFontSize: 14, proseLineHeight: 1.7,
    }));
    for (const name of TOKENS) expect(token(name)).toBe("");
    window.removeEventListener("resize", resize);
  });
});

function Harness(props: { onChange: (appearance: AppearanceSettings) => void; initial?: Partial<AppearanceSettings> }) {
  const [appearance, setAppearance] = useReducer((_: AppearanceSettings, next: AppearanceSettings) => next, null, () => ({ ...loadAppearance(), ...props.initial }));
  return (
    <EditorFontSettingsGroups
      appearance={appearance}
      setAppearance={(next) => { setAppearance(next); props.onChange(next); }}
    />
  );
}

const GROUPS: Record<string, string> = { "Source editor": "source-editor-type", "Visual Markdown editor": "prose-editor-type" };
const group = (title: string) => {
  const section = document.querySelector<HTMLElement>(`[data-setting="${GROUPS[title]}"]`);
  expect(within(section!).getByRole("heading", { name: title })).toBeInTheDocument();
  return within(section!);
};

async function choose(title: string, option: string) {
  const trigger = group(title).getByRole("combobox", { name: "Font" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  fireEvent.click(await screen.findByRole("option", { name: option }));
}

describe("editor font settings", () => {
  it("sets each editor's face apart, from the list or by an installed font's name", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    await choose("Source editor", "OpenDyslexic");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sourceFont: "OpenDyslexic", proseFont: "" }));

    await choose("Visual Markdown editor", "Other font…");
    const name = screen.getByRole("textbox", { name: "Font name" });
    fireEvent.change(name, { target: { value: "Fira " } });
    // The typed space stays in the field while the stored name is trimmed.
    expect(name).toHaveValue("Fira ");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ sourceFont: "OpenDyslexic", proseFont: "Fira" }));

    await choose("Visual Markdown editor", "Default");
    expect(screen.queryByRole("textbox", { name: "Font name" })).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ proseFont: "" }));
  });

  it("reopens a typed face in its name field", () => {
    render(<Harness onChange={vi.fn()} initial={{ sourceFont: "Fira Code" }} />);
    expect(screen.getByRole("textbox", { name: "Font name" })).toHaveValue("Fira Code");
  });

  it("moves line height in steps of 0.05", () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const prose = group("Visual Markdown editor").getByRole("slider", { name: "Line height" });
    expect(prose).toHaveAttribute("step", "0.05");
    fireEvent.change(prose, { target: { value: "1.95" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ proseLineHeight: 1.95 }));
    expect(group("Visual Markdown editor").getByText("1.95")).toBeInTheDocument();
  });
});
