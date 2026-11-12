/**
 * Every phrase the UI recognizes a backend error by is still written by the
 * Rust source named beside it. Rust errors cross IPC as prose, so rewording
 * one (or a reqwest upgrade rewording its own) would silently change retry,
 * sign-out and setup prompts while every TS test, which hardcodes the old
 * text, stays green. Only string literals count: a phrase surviving in a
 * comment proves nothing.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OVERLEAF_UNREACHABLE, RESPONSE_BODY_UNDECODABLE } from "../app/overleaf-sync-failures";
import {
  INSTALL_TEX,
  isMissingPaperToolsError,
  isMissingTexBuildError,
  LATEX_TOOL_MISSING,
  LATEXMK_NOT_STARTED,
  PAPER_TOOLS_MISSING,
} from "../build/tex-setup";
import {
  NEWER_OVERLEAF_CONNECTION,
  OVERLEAF_NOT_CONNECTED,
  OVERLEAF_PROJECT_ACCESS_LOST,
  OVERLEAF_SESSION_EXPIRED,
  OVERLEAF_SESSION_STILL_VALID,
  PROJECT_CHANGED,
  PROJECT_NOT_LINKED,
} from "../overleaf/overleaf-realtime-model";
import { METADATA_INCOMPLETE, PREPRINT_INCOMPLETE } from "../papers/audit-messages";
import { NO_SUCH_FILE, NOT_A_FOLDER } from "../project/project-dialogs";
import { mentionsAny } from "./ipc-error-phrases";

/** Each matched phrase and the file under src-tauri that writes it. */
const PHRASES: [phrase: string, rustSource: string][] = [
  [OVERLEAF_UNREACHABLE, "lattice-core/src/overleaf/api.rs"],
  // reqwest's own Display text, pinned by a test there.
  [RESPONSE_BODY_UNDECODABLE, "lattice-core/src/overleaf/api.rs"],
  [OVERLEAF_SESSION_EXPIRED, "lattice-core/src/overleaf_rt.rs"],
  [OVERLEAF_NOT_CONNECTED, "lattice-core/src/overleaf_rt.rs"],
  [OVERLEAF_SESSION_STILL_VALID, "lattice-core/src/overleaf_rt.rs"],
  [OVERLEAF_PROJECT_ACCESS_LOST, "lattice-core/src/overleaf_rt.rs"],
  [PROJECT_CHANGED, "src/ipc.rs"],
  [PROJECT_NOT_LINKED, "lattice-core/src/overleaf/link.rs"],
  [NEWER_OVERLEAF_CONNECTION, "src/ipc/overleaf_realtime.rs"],
  [NO_SUCH_FILE, "lattice-core/src/project/manifest.rs"],
  [NOT_A_FOLDER, "lattice-core/src/project/manifest.rs"],
  [PAPER_TOOLS_MISSING, "lattice-core/src/commands/python_tools.rs"],
  [LATEXMK_NOT_STARTED, "lattice-core/src/latex/build.rs"],
  [INSTALL_TEX, "lattice-core/src/latex/build.rs"],
  [LATEX_TOOL_MISSING, "lattice-core/src/latex/build_log.rs"],
  [METADATA_INCOMPLETE, "lattice-core/src/citation_audit/check.rs"],
  [PREPRINT_INCOMPLETE, "lattice-core/src/citation_audit/check.rs"],
];

/**
 * Rust tokens a quote can appear in, earliest first: comments, raw strings,
 * strings and char literals. One pass keeps a `'"'` or a quote inside a
 * comment from pairing the wrong quotes; a lifetime (`'a`) matches nothing.
 */
const RUST_TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\br(#*)"([\s\S]*?)"\1|"((?:[^"\\]|\\[\s\S])*)"|'(?:[^'\\\n]|\\.[^'\n]*)'/g;

/** The string literals of a file under src-tauri. */
function stringLiterals(rustSource: string): string[] {
  const source = readFileSync(`src-tauri/${rustSource}`, "utf8");
  return [...source.matchAll(RUST_TOKEN)].flatMap((token) => token[2] ?? token[3] ?? []);
}

describe("IPC error phrases", () => {
  it.each(PHRASES)("%s is still written by src-tauri/%s", (phrase, rustSource) => {
    expect(stringLiterals(rustSource).some((literal) => mentionsAny(literal, [phrase]))).toBe(true);
  });

  it("matches the phrases case-insensitively, wherever a step wraps them", () => {
    expect(mentionsAny("Sync failed: OVERLEAF SESSION EXPIRED.", [OVERLEAF_SESSION_EXPIRED])).toBe(true);
    expect(mentionsAny("Overleaf returned 500.", [OVERLEAF_SESSION_EXPIRED, OVERLEAF_NOT_CONNECTED])).toBe(false);
    expect(isMissingTexBuildError("Could not start latexmk. Install MacTeX or TeX Live. No such file")).toBe(true);
    expect(isMissingPaperToolsError("Lattice's paper tools are not installed. Install them in Settings.")).toBe(true);
  });
});
