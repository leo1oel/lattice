import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfCompoundKeyHover } from "./pdf-compound-key-hover";

const host = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
  files: new Map<string, string>(),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: host.invoke }));
vi.mock("../telemetry/app-notify", () => ({ notifyCopied: vi.fn() }));

const CHEMNUM_AUX = String.raw`\relax
\chemnum@cmpd {ketone}{1}{1}{}{}{}{}{\bfseries }`;
/** The source line SyncTeX names: a compound and a citation typeset together. */
const LINE = String.raw`Reduction of \cmpd{ketone} as in \cite{smith}.`;
const BOX = { left: 10, top: 10, right: 30, bottom: 30, width: 20, height: 20, x: 10, y: 10 };

const writeText = vi.fn(async (_text: string) => {});

/** A PDF page whose text layer holds one run, with a citation link drawn over it on demand. */
function page(text: string, link = false) {
  const root = document.createElement("div");
  root.innerHTML = `<div data-page-number="1" style="--scale-factor: 1"><div class="textLayer"><span>${text}</span></div>`
    + `${link ? `<section class="annotationLayer"><a href="#cite.smith">${text}</a></section>` : ""}</div>`;
  document.body.append(root);
  for (const element of root.querySelectorAll("span, a")) {
    vi.spyOn(element, "getBoundingClientRect").mockReturnValue({ ...BOX, toJSON: () => BOX });
  }
  return { root, span: root.querySelector("span")!, link: root.querySelector("a") };
}

const synctexCalls = () => host.invoke.mock.calls.filter(([command]) => command === "synctex_edit").length;

async function rest(target: Element) {
  fireEvent.pointerMove(target, { clientX: 20, clientY: 20 });
  // Past the pointer's rest, and the reads after it.
  await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
}

beforeEach(() => {
  host.files = new Map([["main.tex", LINE]]);
  host.invoke.mockImplementation(async (command, args) => {
    if (command === "synctex_edit") return { path: "main.tex", line: 1 };
    if (command === "read_project_file") {
      const text = host.files.get(String(args?.path));
      if (text === undefined) throw new Error("no such file");
      return text;
    }
    throw new Error(`unexpected ${command}`);
  });
  Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  host.invoke.mockReset();
  writeText.mockClear();
});

describe("compound keys in the PDF", () => {
  it("looks for nothing in a project whose build numbered no compound", async () => {
    host.files.set("main.aux", String.raw`\relax \newlabel{x}{{1}{1}}`);
    const { root, span } = page("1");
    render(<PdfCompoundKeyHover host={root} projectRoot="/p" build={{ rootDocument: "main.tex" }} />);
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith("read_project_file", { path: "main.aux", projectRoot: "/p" }));
    await rest(span);
    expect(synctexCalls()).toBe(0);
    expect(screen.queryByRole("group")).toBeNull();
  });

  it("shows a key only on the number the build gave it, not on a citation number of the same line", async () => {
    host.files.set("main.aux", CHEMNUM_AUX);
    const citation = page("[12]");
    const { rerender } = render(<PdfCompoundKeyHover host={citation.root} projectRoot="/p" build={{ rootDocument: "main.tex" }} />);
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith("read_project_file", { path: "main.aux", projectRoot: "/p" }));
    await rest(citation.span);
    expect(synctexCalls()).toBe(0);
    expect(screen.queryByRole("group")).toBeNull();

    const compound = page("1");
    rerender(<PdfCompoundKeyHover host={compound.root} projectRoot="/p" build={{ rootDocument: "main.tex" }} />);
    await rest(compound.span);
    expect(await screen.findByRole("button", { name: String.raw`\cmpd{ketone}` })).toBeTruthy();
  });

  it("copies the command on a click on the number, never on a click on a link over it", async () => {
    host.files.set("main.aux", CHEMNUM_AUX);
    const { root, span, link } = page("1", true);
    render(<PdfCompoundKeyHover host={root} projectRoot="/p" build={{ rootDocument: "main.tex" }} />);
    await waitFor(() => expect(host.invoke).toHaveBeenCalledWith("read_project_file", { path: "main.aux", projectRoot: "/p" }));

    // Resting on the link is the link's own card.
    await rest(link!);
    expect(synctexCalls()).toBe(0);

    await rest(span);
    await screen.findByRole("group");
    fireEvent.pointerDown(link!, { clientX: 20, clientY: 20 });
    fireEvent.click(link!, { clientX: 20, clientY: 20, detail: 1 });
    await act(() => new Promise((resolve) => setTimeout(resolve, 400)));
    expect(writeText).not.toHaveBeenCalled();

    await rest(span);
    await screen.findByRole("group");
    fireEvent.pointerDown(span, { clientX: 20, clientY: 20 });
    fireEvent.click(span, { clientX: 20, clientY: 20, detail: 1 });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(String.raw`\cmpd{ketone}`));
  });
});
