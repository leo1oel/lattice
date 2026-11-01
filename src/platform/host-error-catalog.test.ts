/**
 * Every host message the interface translates is still the text the Rust
 * file beside it writes: Rust errors cross IPC as prose, so rewording one
 * would otherwise fall back to English with every test green. Its English
 * message is that same sentence, and it has a Chinese translation.
 */
import { readFileSync } from "node:fs";
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
      const placeholders = rustLiteralPattern(literal).pattern.source.split("([\\s\\S]+").length - 1;
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
