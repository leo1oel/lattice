/**
 * Builds of more than one root document, as the backend answers them: a
 * build compiles the open file when it is a document of its own
 * (`\documentclass`, as `choose_compile_root` decides), else `main.tex`, and
 * each root document's PDF is its own, so the PDF tab per compiled document
 * (src/trellis/compiled-pdf-tabs.ts) can be driven. `?roots=1` adds a
 * supplement, `supplement/SI.tex`, to the fixture. `?pdf=<url>` answers
 * with that PDF for `main.tex` instead, such as the tutorial compiled outside
 * the checkout, for screenshots of a real page; `?build=running` starts a
 * build that never finishes.
 */
import { runningBuild } from "../mock-backend/build";
import { copyBuffer } from "../mock-backend/project";
import { NOT_HANDLED, type Args, type MockTauri } from "../mock-backend/tauri-internals";

type Roots = {
  params: URLSearchParams;
  files: () => Map<string, string | Uint8Array>;
  /** `main.tex`'s PDF, and its build as the page reports it. */
  mainPdf: Uint8Array;
  build: () => unknown;
  tauri: () => MockTauri;
  root: () => string;
};

const SUPPLEMENT = "supplement/SI.tex";
const SUPPLEMENT_TEXT = "\\documentclass{article}\n\\title{Supplementary information}\n\\begin{document}\n\\maketitle\n\\section{Extended methods}\nThe full derivation.\n\\end{document}\n";

/** A one-page PDF titled `title`, with the document's name under it. */
function titlePdf(title: string, name: string): Uint8Array {
  const text = (size: number, y: number, words: string) => `BT /F1 ${size} Tf 72 ${y} Td (${words.replace(/[\\()]/g, "\\$&")}) Tj ET`;
  const stream = [text(24, 700, title), text(12, 670, name)].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [4 0 R] /Count 1 >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents 5 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = objects.map((body, index) => {
    const at = output.length;
    output += `${index + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = output.length;
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("")}`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(output);
}

/** `build_project`, `read_compiled_pdf`, `read_kept_pdf` and SyncTeX into another document's PDF; `NOT_HANDLED` otherwise. */
export function rootsAnswer(roots: Roots) {
  if (roots.params.has("roots")) roots.files().set(SUPPLEMENT, SUPPLEMENT_TEXT);
  let compiled = "main.tex";
  /** Each document built: its PDF, as the backend keeps a copy of each one's last build. */
  const built = new Set<string>();
  const url = roots.params.get("pdf");
  const pdfOf = (document: string) => (document === "main.tex"
    ? url ? fetch(url).then((response) => response.arrayBuffer()) : copyBuffer(roots.mainPdf)
    : copyBuffer(titlePdf(document === SUPPLEMENT ? "Supplementary information" : document, document.replace(/\.tex$/, ".pdf"))));
  return (command: string, args: Args): unknown => {
    switch (command) {
      case "build_project": {
        if (roots.params.get("build") === "running") return runningBuild(roots.tauri(), roots.root(), args?.progressId);
        const open = String(args?.documentPath ?? "");
        const text = roots.files().get(open);
        compiled = typeof text === "string" && text.includes("\\documentclass") ? open : "main.tex";
        built.add(compiled);
        return { ...roots.build() as object, rootDocument: compiled };
      }
      case "read_compiled_pdf":
        return pdfOf(compiled);
      case "read_kept_pdf": {
        const document = String(args?.document ?? "");
        if (!built.has(document)) throw new Error(`${document} has not been built in Lattice yet.`);
        return pdfOf(document);
      }
      // A click on another document's own PDF lands in that document, near the top.
      case "synctex_edit":
        return args?.document ? { path: String(args.document), line: 5 } : NOT_HANDLED;
      default:
        return NOT_HANDLED;
    }
  };
}
