import { diagnosticCount, forceLinting } from "@codemirror/lint";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { notifyInfo, notifySuccess, notifyWarning } from "../telemetry/app-notify";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../telemetry/app-notify", () => ({ notifyInfo: vi.fn(), notifySuccess: vi.fn(), notifyWarning: vi.fn() }));

import { installDictionary, type SpellingLanguage } from "./document-spelling";
import { harperDiagnostics, harperSpellcheck } from "./harper-spellcheck";

const french: SpellingLanguage = { code: "fr", dictionary: "missing", license: "MPL-2.0", sizeKib: 1404 };

/** What `spelling_lint` reports: each word of `misspelled`, at UTF-16 offsets. */
function spellingLints(text: string, misspelled: string[]) {
  return misspelled.flatMap((word) => {
    const start = text.indexOf(word);
    if (start === -1) return [];
    const end = start + word.length;
    const suggestions = [{ kind: "replace", replacement: "réseau" }];
    return [{ start, end, kind: "Spelling", message: "", suggestions, rule: "SpellCheck", sentenceStart: start, sentenceEnd: end }];
  });
}

type Commands = Record<string, (args: Record<string, unknown>) => unknown>;
function answer(commands: Commands) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    const handler = commands[command];
    if (!handler) throw new Error(`unexpected command ${command}`);
    return handler((args ?? {}) as Record<string, unknown>);
  });
}

// Braced: a hook that returns a function has it called as its cleanup.
beforeEach(() => {
  vi.mocked(invoke).mockReset();
});
afterEach(() => {
  vi.clearAllMocks();
});

describe("spelling in the document's language", () => {
  it("checks with the language's dictionary instead of Harper, in any script", async () => {
    answer({ spelling_lint: ({ text }) => spellingLints(String(text), ["résaeu"]) });
    const onAddProjectWord = vi.fn().mockResolvedValue(true);
    const source = "Le \\emph{résaeu} neuronal.";
    const [diagnostic, ...rest] = await harperDiagnostics(source, { language: "fr", projectWords: ["Lattice"], onAddProjectWord });
    expect(rest).toEqual([]);
    expect(source.slice(diagnostic.from, diagnostic.to)).toBe("résaeu");
    expect(diagnostic.message).toBe("“résaeu” isn't in the French dictionary");
    expect(diagnostic.source).toBe("Hunspell");
    // Accented words can be added to the project dictionary, as English ones can.
    expect(diagnostic.actions?.map((action) => action.name)).toEqual([
      "Replace with “réseau”", "Add “résaeu” to project dictionary",
    ]);
    const [command, args] = vi.mocked(invoke).mock.calls[0];
    expect(command).toBe("spelling_lint");
    expect(args).toMatchObject({ code: "fr", projectWords: ["Lattice"] });
    expect((args as { text: string }).text).toHaveLength(source.length);
  });

  it("downloads a dictionary once, names its licence, and relints when it arrives", async () => {
    let finish = () => {};
    answer({ spelling_install_dictionary: () => new Promise<void>((resolve) => { finish = resolve; }) });
    const first = installDictionary({ ...french, code: "fr-once" });
    expect(installDictionary({ ...french, code: "fr-once" })).toBe(first);
    expect(vi.mocked(notifyInfo).mock.calls[0][2]?.detail).toContain("licensed MPL-2.0");
    finish();
    await expect(first).resolves.toBe(true);
    expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "spelling_install_dictionary")).toHaveLength(1);
    expect(notifySuccess).toHaveBeenCalledOnce();
  });

  it("leaves a language unchecked with a warning when its download fails, and does not retry", async () => {
    answer({ spelling_install_dictionary: () => Promise.reject(new Error("offline")) });
    await expect(installDictionary({ ...french, code: "de-offline" })).resolves.toBe(false);
    await expect(installDictionary({ ...french, code: "de-offline" })).resolves.toBe(false);
    expect(vi.mocked(invoke)).toHaveBeenCalledOnce();
    expect(vi.mocked(notifyWarning).mock.calls[0][2]?.detail).toContain("offline");
  });

  it("never runs Harper on a document in another language, and checks it once its dictionary is in", async () => {
    let state: SpellingLanguage["dictionary"] = "missing";
    answer({
      spelling_document_language: ({ path }) => (path === "main.tex" ? { ...french, code: "fr-view", dictionary: state } : null),
      spelling_install_dictionary: () => {
        state = "installed";
      },
      spelling_lint: ({ text }) => spellingLints(String(text), ["résaeu"]),
      harper_lint: () => {
        throw new Error("Harper ran on a French document");
      },
    });
    const live = { current: { projectRoot: "/project", spellingWords: [] } };
    const view = new EditorView({
      state: EditorState.create({ doc: "Un résaeu neuronal.", extensions: harperSpellcheck(live, "latex", "main.tex") }),
    });
    // The first pass finds the dictionary missing, downloads it, and the
    // download relints with it.
    forceLinting(view);
    await vi.waitFor(() => expect(diagnosticCount(view.state)).toBe(1));
    const commands = vi.mocked(invoke).mock.calls.map(([command]) => command);
    expect(commands).toContain("spelling_install_dictionary");
    expect(commands).not.toContain("harper_lint");
    view.destroy();
  });
});
