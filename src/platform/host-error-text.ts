/**
 * Host errors in the interface language.
 *
 * Rust commands reject with English prose (`Result<_, String>`), and that
 * English stays the error's identity: logs, copied reports, the agent and the
 * phrase checks of `ipc-error-phrases.ts` all read it. Only what a person
 * reads on screen is translated, at the places that show it: the toast stack
 * and `InlineMessage` pass their text through `hostErrorText`, and any other
 * view that shows a rejection takes `hostErrorMessage(reason)` (`app-utils.ts`)
 * instead of `toMessage`.
 *
 * A translation is keyed by the Rust text itself — the `format!` literal, with
 * its `{…}` placeholders standing for the parts that vary — so the catalog
 * (`host-error-catalog.ts`, by area in `host-errors-*.ts`) reads as a list of
 * the host's own sentences. `host-error-text.test.ts` pins every literal to
 * the Rust file named beside it, so a reworded Rust message fails a test
 * instead of quietly falling back to English. Text no entry matches is shown
 * as it is.
 *
 * The catalog is English-sized (a sentence per entry), so it loads with the
 * Chinese catalog in `activateAppLocale` instead of with the app: an English
 * interface never needs it.
 */
// The global instance `src/i18n.ts` activates, imported from Lingui itself
// because `src/i18n.ts` installs this module's catalog.
import { i18n } from "@lingui/core";

/**
 * One host message: the file under `src-tauri/src` that writes it, its Rust
 * literal, and its text in the interface language, given the values of the
 * literal's placeholders in order (each already translated in turn).
 */
export type HostErrorEntry = readonly [rustFile: string, rustLiteral: string, text: (params: string[]) => string];

type CompiledEntry = { pattern: RegExp; text: HostErrorEntry[2]; specificity: number };

let compiled: CompiledEntry[] = [];

// `{{` and `}}` are literal braces in a Rust format string; any other `{…}` is
// an argument, named, positional or with a format spec.
const RUST_FORMAT_TOKEN = /\{\{|\}\}|\{[^{}]*\}/g;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Rust `format!` literal as an anchored pattern capturing each argument. */
export function rustLiteralPattern(literal: string): { pattern: RegExp; specificity: number } {
  let source = "";
  let fixed = 0;
  let last = 0;
  const tokens = [...literal.matchAll(RUST_FORMAT_TOKEN)];
  tokens.forEach((token, index) => {
    const before = literal.slice(last, token.index);
    source += escapeRegExp(before);
    fixed += before.length;
    if (token[0] === "{{" || token[0] === "}}") {
      source += escapeRegExp(token[0][0]);
      fixed += 1;
    } else {
      // The last argument, when nothing follows it, takes the rest of the
      // text (an OS error, an upstream reason); the others stop at the
      // first place the fixed text after them fits.
      const atEnd = index === tokens.length - 1 && token.index + token[0].length === literal.length;
      // eslint-disable-next-line lingui/no-unlocalized-strings -- regular expression source
      source += atEnd ? "([\\s\\S]+)" : "([\\s\\S]+?)";
    }
    last = token.index + token[0].length;
  });
  source += escapeRegExp(literal.slice(last));
  fixed += literal.length - last;
  return { pattern: new RegExp(`^${source}$`), specificity: fixed };
}

/** Make `entries` the translations `hostErrorText` uses; an empty list turns them off. */
export function installHostErrors(entries: readonly HostErrorEntry[]) {
  compiled = entries
    .map(([, literal, text]) => ({ ...rustLiteralPattern(literal), text }))
    // The entry with the most fixed text wins, so "Could not read {}: {}"
    // never claims a message a more specific entry spells out.
    .sort((left, right) => right.specificity - left.specificity);
}

function translateLine(line: string, depth: number): string {
  for (const entry of compiled) {
    const match = entry.pattern.exec(line);
    if (!match) continue;
    // An argument is often another host message ("Could not read x: <io
    // error>"), so it is translated in turn, a few levels deep at most.
    const params = match.slice(1).map((param) => (depth < 3 ? translateLine(param, depth + 1) : param));
    return entry.text(params);
  }
  return line;
}

/** `text` in the interface language when it is a host message Lattice knows, else unchanged. */
export function hostErrorText(text: string): string {
  if (compiled.length === 0 || !text || (i18n.locale ?? "en").startsWith("en")) return text;
  const whole = translateLine(text, 0);
  if (whole !== text) return whole;
  // A toast's detail is several lines (a message, then a trace tag): each
  // line is matched on its own.
  return text.includes("\n") ? text.split("\n").map((line) => translateLine(line, 0)).join("\n") : text;
}
