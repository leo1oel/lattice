/**
 * The math symbol palette (⌥⌘M): the shared vocabulary's math commands, each
 * drawn by KaTeX, found by command name, meaning, or the symbol itself, and
 * written at the caret. Loaded with KaTeX the first time it opens.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { showTooltip, type EditorView, type Tooltip } from "@codemirror/view";
import { msg } from "@lingui/core/macro";
import katex from "katex";
import "katex/dist/katex.min.css";
import { i18n } from "../../i18n";
import { element } from "../dom-utils";
import { VOCABULARY_COMMANDS } from "./latex-vocabulary";
import { mathRegionInDocument } from "./math-region";

type PaletteSymbol = { name: string; insert: string; detail: string; html: string; glyph: string };

let symbols: PaletteSymbol[] | null = null;

/** Every math command once, drawn with an empty box where its arguments go. */
function paletteSymbols(): PaletteSymbol[] {
  symbols ??= VOCABULARY_COMMANDS.filter((entry) => entry.math).map(({ name, template, detail }) => {
    const insert = template ?? name;
    let html = "";
    try {
      // The option's label names it, so the glyph needs no MathML of its own.
      // eslint-disable-next-line lingui/no-unlocalized-strings -- KaTeX option values
      html = katex.renderToString(insert.replaceAll("{}", "{\\square}"), { output: "html", throwOnError: true, strict: "ignore" });
    } catch {
      // A command KaTeX cannot draw shows its name instead.
    }
    const glyph = html.replace(/<[^>]+>/g, "").replace(/\s+/g, "");
    return { name, insert, detail: i18n._(detail), html, glyph };
  });
  return symbols;
}

/** Symbols whose command, meaning, or drawn glyph holds `query`. */
export function matchSymbols(query: string): PaletteSymbol[] {
  const needle = query.trim().toLocaleLowerCase().replace(/^\\/, "");
  if (!needle) return paletteSymbols();
  return paletteSymbols().filter((symbol) => symbol.name.slice(1).toLocaleLowerCase().includes(needle)
    || symbol.detail.toLocaleLowerCase().includes(needle) || (symbol.glyph !== "" && symbol.glyph === query.trim()));
}

const setPalette = StateEffect.define<Tooltip | null>();

/** The open palette; an edit or caret move elsewhere closes it. */
const paletteField = StateField.define<Tooltip | null>({
  create: () => null,
  update(palette, transaction) {
    for (const effect of transaction.effects) if (effect.is(setPalette)) return effect.value;
    return palette && (transaction.docChanged || transaction.selection) ? null : palette;
  },
  provide: (field) => showTooltip.from(field),
});

/**
 * Writes the command over the selection, with the caret in its first `{}`
 * or after it; outside math it goes in `$…$`. A letter right after the caret
 * would run on into a command's name, so a space keeps them apart.
 */
function insertSymbol(view: EditorView, symbol: PaletteSymbol): void {
  const { from, to } = view.state.selection.main;
  const inMath = mathRegionInDocument(view.state.doc, from) !== null;
  const spaced = /[A-Za-z]$/.test(symbol.insert) && /^[A-Za-z]/.test(view.state.sliceDoc(to, to + 1)) ? " " : "";
  const insert = inMath ? `${symbol.insert}${spaced}` : `$${symbol.insert}$`;
  const group = insert.indexOf("{}");
  const caret = group >= 0 ? group + 1 : inMath ? symbol.insert.length : insert.length - 1;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + caret },
    effects: setPalette.of(null),
    scrollIntoView: true,
    userEvent: "input",
  });
  view.focus();
}

function paletteDom(view: EditorView, close: () => void): { dom: HTMLElement; input: HTMLInputElement } {
  const dom = element("div", "symbol-palette");
  dom.setAttribute("role", "dialog");
  dom.setAttribute("aria-label", i18n._(msg`Math symbols`));
  const input = element("input");
  input.type = "search";
  input.placeholder = i18n._(msg`Search by symbol, command or meaning`);
  input.setAttribute("aria-controls", "symbol-palette-options");
  const grid = element("div", "symbol-palette-grid");
  grid.id = "symbol-palette-options";
  grid.setAttribute("role", "listbox");
  const empty = element("p", "symbol-palette-empty");
  let shown: PaletteSymbol[] = [];
  let active = 0;
  const highlight = (index: number) => {
    active = Math.max(0, Math.min(index, shown.length - 1));
    grid.querySelectorAll("[aria-selected=true]").forEach((option) => option.setAttribute("aria-selected", "false"));
    const option = grid.children[active];
    option?.setAttribute("aria-selected", "true");
    option?.scrollIntoView({ block: "nearest" });
    if (option) input.setAttribute("aria-activedescendant", option.id);
    else input.removeAttribute("aria-activedescendant");
  };
  const render = () => {
    shown = matchSymbols(input.value);
    grid.replaceChildren(...shown.map((symbol, index) => {
      const option = element("button", "symbol-palette-option");
      option.type = "button";
      option.id = `symbol-palette-option-${index}`;
      option.tabIndex = -1;
      option.setAttribute("role", "option");
      option.title = `${symbol.name} · ${symbol.detail}`;
      option.setAttribute("aria-label", option.title);
      if (symbol.html) option.innerHTML = symbol.html;
      else option.textContent = symbol.name;
      option.addEventListener("click", () => insertSymbol(view, symbol));
      return option;
    }));
    const query = input.value.trim();
    empty.textContent = i18n._(msg`No symbol matches “${query}”.`);
    empty.hidden = shown.length > 0;
    highlight(0);
  };
  input.addEventListener("input", render);
  const columns = 8;
  const moves: Record<string, number> = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -columns, ArrowDown: columns };
  dom.addEventListener("keydown", (event) => {
    if (event.key in moves) highlight(active + moves[event.key]);
    else if (event.key === "Enter" && shown[active]) insertSymbol(view, shown[active]);
    else if (event.key === "Escape") {
      close();
      view.focus();
    } else return;
    event.preventDefault();
    event.stopPropagation();
  });
  // Choosing a symbol keeps focus in the search field, so the palette stays open under the pointer.
  dom.addEventListener("mousedown", (event) => {
    if (event.target !== input) event.preventDefault();
  });
  dom.addEventListener("focusout", (event) => {
    if (!(event.relatedTarget instanceof Node && dom.contains(event.relatedTarget))) close();
  });
  dom.append(input, grid, empty);
  render();
  return { dom, input };
}

export function openSymbolPalette(view: EditorView): void {
  const installed = view.state.field(paletteField, false) !== undefined;
  const close = () => {
    if (view.state.field(paletteField, false)) view.dispatch({ effects: setPalette.of(null) });
  };
  const palette: Tooltip = {
    pos: view.state.selection.main.head,
    above: false,
    create() {
      const { dom, input } = paletteDom(view, close);
      return { dom, mount: () => input.focus() };
    },
  };
  // A field joins with its initial value, so it takes the palette in a second step.
  if (!installed) view.dispatch({ effects: StateEffect.appendConfig.of(paletteField) });
  view.dispatch({ effects: setPalette.of(palette) });
}
