import { describe, expect, it, vi } from "vitest";
import { katexMacrosFromSources } from "../latex-text";
import { parseFloat } from "./visual-float";
import { parseTable } from "./visual-table";
import { edits, host, text, visualView } from "./visual-test-editor";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => "") }));
vi.hoisted(() => {
  Object.defineProperty(navigator, "platform", { value: "MacIntel", configurable: true });
});

/** The captain's figure: two minipages, each a parboxed PDF with its own caption and label. */
const MINIPAGES = String.raw`\begin{figure}[ht]
\centering
\captionsetup{position=bottom,belowskip=0pt}
\begin{minipage}[t]{0.49\linewidth}
\centering
\parbox[c][0.65\linewidth][c]{\linewidth}{\centering\includegraphics[width=\linewidth]{figures/case_failure_mmsi.pdf}}
\caption{\textbf{A low-fidelity panorama leads to an error.} Key objects are missing or duplicated.}
\label{fig:case-failure}
\end{minipage}\hfill
\begin{minipage}[t]{0.49\linewidth}
\centering
\parbox[c][0.65\linewidth][c]{\linewidth}{\centering\includegraphics[width=\linewidth]{figures/cost_scatter.pdf}}
\caption{\textbf{Accuracy and latency on V$^\star$.} TeaCache reduces latency without lowering accuracy.}
\label{fig:cost}
\end{minipage}
\end{figure}`;

const SUBFIGURES = String.raw`\begin{figure*}[t]
  \centering
  \begin{subfigure}[b]{0.48\textwidth}
    \includegraphics[width=\linewidth]{figures/a.png}
    \caption{Left}
  \end{subfigure}
  \hfill
  \begin{subfigure}[b]{0.48\textwidth}
    \includegraphics[width=\linewidth]{figures/b.png}
    \caption{Right}
  \end{subfigure}
  \caption{Both sides.}
  \label{fig:both}
\end{figure*}`;

const BOOKTABS = String.raw`\begin{table*}[t]
\centering
\caption{Main results.}
\label{tab:main}
\resizebox{\linewidth}{!}{%
\begin{tabular}{@{}lcc@{}}
\toprule
\multirow{2}{*}{Model} & \multicolumn{2}{c}{Accuracy} \\
\cmidrule(lr){2-3}
 & Val & Test \\
\midrule
Ours & \textbf{81.2} & 79.0 \\
Base & 75.1 & 74.3 \\
\bottomrule
\end{tabular}}
\end{table*}`;

const AUTHOR_PREAMBLE = String.raw`\newcommand{\aff}[1]{\textsuperscript{#1}}
\newcommand{\leadmark}{\textsuperscript{\(\star\)}}
\def\equalcontrib{\textsuperscript{\(\dagger\)}}
`;
const AUTHOR = String.raw`\documentclass{article}
${AUTHOR_PREAMBLE}\title{Seeing the Whole Room}
\author{%
  Jiawei Gu\aff{1}\leadmark \quad Linjie Li\aff{1}\leadmark \quad Yiming Liu\aff{2}\equalcontrib \\
  \bfseries Guanzheng Chen\aff{4}\equalcontrib \quad Zhichao Peng\aff{5} \\[6pt]
  \normalfont\small
  \aff{1}University of Washington \quad \aff{2}Tsinghua University \\[4pt]
  \normalfont\small
  \leadmark\,Project lead \qquad \equalcontrib\,Equal contribution
}
\begin{document}
\maketitle
Body.
\end{document}
`;

const BODY = String.raw`\begin{document}
\vspace{-18pt}
{\centering\small\hypersetup{urlcolor=teal}
  \url{https://example.org/ssl/}\par
}
\vspace{4pt}

Some text.

\begin{ack}
We thank everyone.
\end{ack}

\bibliographystyle{plainnat}
\bibliography{references}

\newpage
\appendix
\raggedbottom
\section{More}
\end{document}
`;

describe("Visual mode floats and tables", () => {
  it("lays out side-by-side minipages with their own images and numbered captions, leaving the source alone", async () => {
    const doc = `Before.\n\n${MINIPAGES}\n\nAfter.`;
    const view = await visualView(doc);
    const block = view.contentDOM.querySelector(".lx-tex-float-block")!;
    expect(block).not.toBeNull();
    const panels = block.querySelectorAll(".lx-tex-float-row > .lx-tex-float-panel");
    expect(panels).toHaveLength(2);
    expect([...panels].map((panel) => panel.querySelectorAll(".lx-tex-float-image").length)).toEqual([1, 1]);
    const captions = [...block.querySelectorAll(".lx-tex-float-caption")].map((caption) => caption.textContent);
    expect(captions[0]).toMatch(/^Figure \?: A low-fidelity panorama leads to an error\./);
    expect(captions[1]).toMatch(/^Figure \?: Accuracy and latency on V/);
    expect(block.querySelector(".lx-tex-float-caption .katex")).not.toBeNull();
    expect(text(view)).not.toMatch(/\\(?:captionsetup|parbox|minipage|centering|hfill)/);
    expect(view.state.doc.toString()).toBe(doc);
    expect(edits).toEqual([]);
  });

  it("shows a float's source when a caption is clicked, and draws it again when the caret leaves", async () => {
    const doc = `Before.\n\n${MINIPAGES}\n\nAfter.`;
    const view = await visualView(doc);
    const caption = view.contentDOM.querySelectorAll<HTMLElement>(".lx-tex-float-caption")[1];
    caption.dispatchEvent(new MouseEvent("mouseup", { button: 0, bubbles: true }));
    expect(view.state.selection.main.head).toBe(doc.indexOf("\\textbf{Accuracy"));
    expect(view.contentDOM.querySelector(".lx-tex-float-block")).toBeNull();
    // The caret is in the float: it is edited line by line, its environments as source.
    expect(text(view)).toContain("\\begin{minipage}[t]{0.49\\linewidth}");
    view.dispatch({ selection: { anchor: doc.length } });
    expect(view.contentDOM.querySelector(".lx-tex-float-block")).not.toBeNull();
    expect(view.state.doc.toString()).toBe(doc);
    expect(edits).toEqual([]);
  });

  it("letters subfigure captions and numbers the figure's own", async () => {
    const view = await visualView(`${SUBFIGURES}\n\nAfter.`);
    const captions = [...view.contentDOM.querySelectorAll(".lx-tex-float-caption")].map((caption) => caption.textContent);
    expect(captions).toEqual(["(a) Left", "(b) Right", "Figure ?: Both sides."]);
    expect(view.contentDOM.querySelectorAll(".lx-tex-float-row .lx-tex-float-panel")).toHaveLength(2);
  });

  it("draws a booktabs table with spans and rules inside its wrappers, under its caption", async () => {
    const view = await visualView(`${BOOKTABS}\n\nAfter.`);
    const table = view.contentDOM.querySelector(".lx-tex-float-block .lx-tex-table")!;
    expect(table).not.toBeNull();
    expect(view.contentDOM.querySelector(".lx-tex-float-caption")?.textContent).toBe("Table ?: Main results.");
    const rows = [...table.querySelectorAll("tr")];
    expect(rows.map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent?.trim()))).toEqual([
      ["Model", "Accuracy"], ["Val", "Test"], ["Ours", "81.2", "79.0"], ["Base", "75.1", "74.3"],
    ]);
    const [model, accuracy] = rows[0].querySelectorAll("td");
    expect(model.rowSpan).toBe(2);
    expect(accuracy.colSpan).toBe(2);
    expect(rows[0].classList.contains("rule-above-heavy")).toBe(true);
    expect(text(view)).not.toMatch(/\\(?:resizebox|toprule|multicolumn)/);
  });

  it("draws a table outside a float as a table, and an unknown picture as a named placeholder", async () => {
    const doc = String.raw`\begin{tabularx}{\linewidth}{lX}
a & b \\
\end{tabularx}

\begin{figure}
\begin{tikzpicture}
\draw (0,0) -- (1,1);
\end{tikzpicture}
\caption{A drawing.}
\end{figure}

After.`;
    const view = await visualView(doc);
    const blocks = view.contentDOM.querySelectorAll(".lx-tex-float-block");
    expect(blocks).toHaveLength(2);
    expect(blocks[0].classList.contains("is-bare")).toBe(true);
    expect(blocks[0].querySelector("td")?.textContent).toBe("a");
    expect(blocks[1].querySelector(".lx-tex-float-opaque")?.textContent).toBe("TikZ picture");
    expect(blocks[1].querySelector(".lx-tex-float-caption")?.textContent).toBe("Figure ?: A drawing.");
  });

  it("sets an author block with the preamble's macros, line breaks and font switches, without raw commands", async () => {
    const view = await visualView(AUTHOR, AUTHOR.length, host({ katexMacros: katexMacrosFromSources([AUTHOR_PREAMBLE]) }));
    const block = view.contentDOM.querySelector(".lx-tex-title-block")!;
    expect(block.querySelector(".lx-tex-title")?.textContent).toBe("Seeing the Whole Room");
    const authors = block.querySelector(".lx-tex-authors")!;
    // What reads on screen: KaTeX's MathML copy keeps its TeX source for screen readers.
    const visible = authors.cloneNode(true) as Element;
    visible.querySelectorAll(".katex-mathml").forEach((node) => node.remove());
    expect(visible.textContent).not.toMatch(/\\|aff|leadmark|equalcontrib|quad|bfseries|normalfont/);
    expect(authors.textContent).toContain("Jiawei Gu");
    expect(authors.textContent).toContain("University of Washington");
    expect(authors.querySelectorAll("sup").length).toBeGreaterThanOrEqual(8);
    expect(authors.querySelectorAll("br, .lx-tex-break-gap").length).toBeGreaterThanOrEqual(3);
    expect(edits).toEqual([]);
  });

  it("hides layout and setup commands, draws the link, acknowledgments and document parts quietly", async () => {
    const view = await visualView(BODY);
    const shown = text(view)!;
    expect(shown).not.toMatch(/\\(?:vspace|hypersetup|centering|small|bibliographystyle|newpage|raggedbottom|appendix|bibliography|url)/);
    expect(view.contentDOM.querySelector(".lx-tex-link")?.textContent).toBe("https://example.org/ssl/");
    expect(shown).toContain("Acknowledgments");
    expect([...view.contentDOM.querySelectorAll(".lx-tex-marker-bar")].map((bar) => bar.textContent)).toEqual(["References", "Appendix"]);
    expect(view.state.doc.toString()).toBe(BODY);
    expect(edits).toEqual([]);
  });
});

describe("float and table layout", () => {
  it("keeps each node's offset into the document", () => {
    const nodes = parseFloat(MINIPAGES, 100);
    const row = nodes.find((node) => node.kind === "row");
    expect(row?.kind).toBe("row");
    if (row?.kind !== "row") return;
    const [first] = row.items;
    expect(first.from).toBe(100 + MINIPAGES.indexOf("\\begin{minipage}"));
    if (first.kind !== "panel") throw new Error("expected a panel");
    expect(first.width).toBe(0.49);
    const caption = first.children.find((node) => node.kind === "caption");
    expect(caption?.kind === "caption" && caption.label).toBe("fig:case-failure");
  });

  it("reads column alignment and rules from a tabular preamble", () => {
    const table = parseTable(String.raw`\begin{tabular}{|l|c|r|}\hline a & b & c \\ \hline\end{tabular}`, 0)!;
    expect(table.columns.map((column) => column.align)).toEqual(["left", "center", "right"]);
    expect(table.columns[0].left).toBe(true);
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0].above).toBe("light");
    expect(table.rows[0].below).toBe("light");
  });
});
