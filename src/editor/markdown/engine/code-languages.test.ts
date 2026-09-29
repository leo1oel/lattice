/** Clean implementation for Lattice; spec: docs/visual-editor-spec.md */
import { describe, expect, it } from "vitest";
import { CODE_LANGUAGES, codeLanguageLabel, resolveCodeLanguage } from "./code-languages";

describe("code block languages (R-BLK-7, R-FMT-8)", () => {
  it("offers Plain text first and Mermaid among the named languages", () => {
    expect(CODE_LANGUAGES[0]?.value).toBe("text");
    expect(CODE_LANGUAGES.map((language) => language.value)).toContain("mermaid");
    expect(new Set(CODE_LANGUAGES.map((language) => language.value)).size).toBe(CODE_LANGUAGES.length);
  });

  it.each([
    ["ts", "typescript", "TypeScript"],
    ["TS", "typescript", "TypeScript"],
    ["py", "python", "Python"],
    ["golang", "go", "Go"],
    ["yml", "yaml", "YAML"],
    ["xml", "html", "HTML"],
    ["html", "html", "HTML"],
    ["ini", "toml", "TOML"],
    ["tex", "latex", "LaTeX"],
  ])("resolves the authored %s to the %s entry, labelled %s", (authored, value, label) => {
    expect(resolveCodeLanguage(authored)?.value).toBe(value);
    expect(codeLanguageLabel(authored, "Plain text")).toBe(label);
  });

  it("labels plain and unknown languages without highlighting them", () => {
    expect(codeLanguageLabel("txt", "纯文本")).toBe("纯文本");
    expect(resolveCodeLanguage("txt")?.grammar).toBeUndefined();
    expect(resolveCodeLanguage("mermaid")?.grammar).toBeUndefined();
    expect(resolveCodeLanguage("brainfuck-ish")).toBeNull();
    expect(codeLanguageLabel("brainfuck-ish", "Plain text")).toBe("brainfuck-ish");
  });

  it("highlights every named language with a grammar lowlight has", () => {
    const grammars = CODE_LANGUAGES.flatMap((language) => (language.grammar ? [language.grammar] : []));
    expect(grammars).toContain("typescript");
    expect(grammars).not.toContain("plaintext");
  });
});
