/**
 * Every host message the interface translates is still the text the Rust
 * file beside it writes: Rust errors cross IPC as prose, so rewording one
 * would otherwise fall back to English with every test green. Its English
 * message is that same sentence, and it has a Chinese translation. And every
 * error a Rust command returns is in the catalog, or listed below with the
 * reason no person reads it.
 */
import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { activateAppLocale } from "../i18n";
import { HOST_ERRORS } from "./host-error-catalog";
import { rustLiteralPattern } from "./host-error-text";
import { STD_ERRORS_FILE } from "./host-errors-workspace";

/** Rust tokens a quote can appear in, as in `ipc-error-phrases.test.ts`. */
const RUST_TOKEN = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|\br(#*)"([\s\S]*?)"\1|"((?:[^"\\]|\\[\s\S])*)"|'(?:[^'\\\n]|\\.[^'\n]*)'/g;

/** A Rust string literal's value: escapes decoded, a `\` line continuation joined. */
function unescapeRust(literal: string): string {
  return literal.replace(/\\(\n\s*|u\{([0-9a-fA-F]+)\}|[\s\S])/g, (_, escape: string, code?: string) => {
    if (code) return String.fromCodePoint(Number.parseInt(code, 16));
    if (escape.startsWith("\n")) return "";
    return ({ n: "\n", t: "\t", r: "\r", "0": "\0" } as Record<string, string>)[escape] ?? escape;
  });
}

const literalsByFile = new Map<string, Set<string>>();
function stringLiterals(rustFile: string): Set<string> {
  let literals = literalsByFile.get(rustFile);
  if (!literals) {
    const source = readFileSync(`src-tauri/src/${rustFile}`, "utf8");
    literals = new Set([...source.matchAll(RUST_TOKEN)].flatMap((token) => token[2] ?? (token[3] === undefined ? [] : unescapeRust(token[3]))));
    literalsByFile.set(rustFile, literals);
  }
  return literals;
}

const RUST_ENTRIES = HOST_ERRORS.filter(([file]) => file !== STD_ERRORS_FILE);

/** The literal with each argument replaced by `values`, as `format!` would write it. */
function formatted(literal: string, values: string[]): string {
  let index = 0;
  return literal.replace(/\{\{|\}\}|\{[^{}]*\}/g, (token) => (token === "{{" ? "{" : token === "}}" ? "}" : values[index++]));
}

// Arguments whose English the translation deliberately does not repeat.
const SAMPLE_ARGUMENTS: Record<string, string[]> = {
  "The project changed before {action}.": ["the action could start"],
  "Overleaf returned {} {what}.": ["«0»", "for the request"],
  "Open Slide refresh failed{subject} ({status}): {}": ["", "«1»", "«2»"],
};

afterEach(async () => {
  await activateAppLocale("en");
});

describe("host error catalog", () => {
  it.each(RUST_ENTRIES)("src-tauri/src/%s still writes %j", (rustFile, literal) => {
    expect(stringLiterals(rustFile)).toContain(literal);
  });

  it("names each host message once", () => {
    const literals = HOST_ERRORS.map(([, literal]) => literal);
    expect(literals.filter((literal, index) => literals.indexOf(literal) !== index)).toEqual([]);
  });

  it("gives each message, in English, the host's own sentence", () => {
    const mismatches = RUST_ENTRIES.flatMap(([, literal, text]) => {
      const placeholders = rustLiteralPattern(literal).pattern.source.split("([\\s\\S]*").length - 1;
      const values = SAMPLE_ARGUMENTS[literal] ?? Array.from({ length: placeholders }, (_, index) => `«${index}»`);
      const english = text(values);
      return english === formatted(literal, values) ? [] : [{ literal, english }];
    });
    expect(mismatches).toEqual([]);
  });

  it("translates every message into Chinese", async () => {
    await activateAppLocale("zh-CN");
    const untranslated = RUST_ENTRIES.flatMap(([, literal, text]) => {
      const values = Array.from({ length: 4 }, (_, index) => `«${index}»`);
      return /\p{Script=Han}/u.test(text(values)) ? [] : [literal];
    });
    expect(untranslated).toEqual([]);
  });
});

/**
 * Host errors that stay English because no person reads them, each with why.
 * A key is a path under `src-tauri/src` (a file, or a folder ending in `/`)
 * for every error written there, or `<file>: <literal>` for one.
 */
const UNTRANSLATED: Record<string, string> = {
  "synara/host_preferences.rs": "the background preference bridge only logs a fixed failure stage, never displays backend errors",
  "latex/figure_preview.rs": "answers the agent's figure-preview tool, which reads and acts on it",
  "research_env.rs": "the research environment answers the agent, never the interface",
  "research_env/": "the research environment answers the agent, never the interface",
  "process_inspector.rs": "Synara's `ps` replacement prints it to the sidecar, not the interface",
  "citation_audit/proceedings.rs": "a failed proceedings lookup keeps the index's result; the reason is dropped",
  "citation_batch.rs: Pacing queue busy": "becomes a batch failure code, shown as the audit's own status",
  // Requests the interface composes itself, so only a bug in Lattice reaches them.
  "citation_audit/batch.rs: Too many entries in an audit batch.": "the interface sends at most one batch's worth",
  "citation_audit/check.rs: Invalid batch status.": "the interface echoes the status the batch returned",
  "git.rs: Invalid revision: expected a commit hash.": "the interface sends a hash from the history list",
  "ipc/build.rs: The PDF was not sent as binary data.": "the interface always sends the PDF's bytes",
  "ipc/live_preview.rs: Unknown live preview file kind {other:?}.": "the interface sends one of the known kinds",
  "live_preview/session.rs: Live preview does not accept the command {command:?}.": "the interface sends one of the known commands",
  "ipc/overleaf_realtime.rs: Invalid Overleaf checkpoint version.": "the interface sends Overleaf's own version back",
  "synara.rs: Invalid agent task action.": "the agent panel sends one of the known actions",
  "synara/preferences.rs: The disabled agent skills must contain only names.": "the settings page writes the list of names itself",
};

/** Files under `src-tauri/src` holding only tests: `#[cfg(test)] mod name;` declares each. */
function testOnlyFiles(files: string[]): Set<string> {
  const tests = new Set<string>();
  for (const file of files) {
    const source = readFileSync(`src-tauri/src/${file}`, "utf8");
    const parent = /(^|\/)(lib|main|mod)\.rs$/.test(file) ? file.replace(/[^/]*$/, "") : file.replace(/\.rs$/, "/");
    for (const [, name] of source.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod (\w+);/g)) {
      tests.add(`${parent}${name}.rs`);
      tests.add(`${parent}${name}/mod.rs`);
    }
  }
  return tests;
}

/** Each `Err("…")` or `Err(format!("…"))` sentence a Rust file outside its tests returns, as the audit counted them. */
function returnedErrors(): Array<{ file: string; literal: string }> {
  const files = (readdirSync("src-tauri/src", { recursive: true }) as string[]).filter((file) => file.endsWith(".rs"));
  const tests = testOnlyFiles(files);
  return files.filter((file) => !tests.has(file) && ![...tests].some((test) => file.startsWith(test.replace(/\.rs$/, "/")))).flatMap((file) => {
    // An inline test module closes the file.
    const source = readFileSync(`src-tauri/src/${file}`, "utf8").split(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod \w+\s*\{/)[0];
    return [...source.matchAll(/\bErr\(\s*(?:format!\(\s*)?"((?:[^"\\]|\\[\s\S])*)"/g)]
      .map((match) => ({ file, literal: unescapeRust(match[1]) }))
      .filter(({ literal }) => /^[A-Z]/.test(literal) && literal.length >= 12);
  });
}

function untranslatedReason(file: string, literal: string): string | undefined {
  return UNTRANSLATED[`${file}: ${literal}`]
    ?? Object.entries(UNTRANSLATED).find(([key]) => !key.includes(": ") && (key.endsWith("/") ? file.startsWith(key) : file === key))?.[1];
}

describe("host error coverage", () => {
  const patterns = HOST_ERRORS.map(([, literal]) => rustLiteralPattern(literal).pattern);
  const uncovered = returnedErrors().filter(({ literal }) => {
    const sample = formatted(literal, Array.from({ length: 8 }, (_, index) => `«${index}»`));
    return !patterns.some((pattern) => pattern.test(sample));
  });

  it("translates every error a Rust command returns, or says why no person reads it", () => {
    expect(uncovered.filter(({ file, literal }) => !untranslatedReason(file, literal)).map(({ file, literal }) => `${file}: ${literal}`)).toEqual([]);
  });

  it("lists no error that is now translated or gone", () => {
    const stale = Object.keys(UNTRANSLATED).filter((key) => !uncovered.some(({ file, literal }) => (
      key.includes(": ") ? key === `${file}: ${literal}` : key.endsWith("/") ? file.startsWith(key) : file === key
    )));
    expect(stale).toEqual([]);
  });
});
