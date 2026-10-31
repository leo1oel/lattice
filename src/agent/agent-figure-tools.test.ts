import { invoke } from "@tauri-apps/api/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDocument } from "../pdf/pdfjs-runtime";
import {
  executeAgentFigureToolRequest,
  figureEnvironment,
  parseAgentFigureToolRequest,
  type AgentFigureToolRequest,
} from "./agent-figure-tools";
import { parseAgentPresentationToolRequest, SYNARA_PRESENTATION_TOOL_REQUEST } from "./agent-presentation-tools";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../pdf/pdfjs-runtime", () => ({ getDocument: vi.fn() }));

const TIKZ = "\\begin{tikzpicture}\n  \\draw (0,0) -- (1,1);\n\\end{tikzpicture}";

const request = (args: Record<string, unknown> = {}): AgentFigureToolRequest => ({
  type: SYNARA_PRESENTATION_TOOL_REQUEST,
  version: 1,
  id: "figure-1",
  action: "preview_figure",
  args: { code: TIKZ, ...args } as AgentFigureToolRequest["args"],
  expiresAt: Date.now() + 60_000,
});

const preview = (overrides: Record<string, unknown> = {}) => ({
  pdf: btoa("%PDF-1.5 figure"),
  errors: [],
  warnings: [],
  preambleFrom: "main.tex",
  preambleFallback: null,
  preambleToAdd: ["\\usetikzlibrary{arrows.meta}"],
  lineWidth: "\\columnwidth",
  engine: "pdflatex",
  durationMs: 812,
  ...overrides,
});

describe("agent figure preview", () => {
  it("takes the presentation channel's preview_figure action, which the page preview leaves alone", () => {
    expect(parseAgentFigureToolRequest(request({ caption: "Loss.", label: "fig:loss", wide: true }))).not.toBeNull();
    expect(parseAgentPresentationToolRequest(request())).toBeNull();
    expect(parseAgentFigureToolRequest({ ...request(), action: "preview_page" })).toBeNull();
    for (const args of [
      { code: "  " },
      { label: "fig loss" },
      { placement: "x" },
      { document: "../main.tex" },
      { wide: "yes" },
      { shellEscape: true },
    ]) {
      expect(parseAgentFigureToolRequest(request(args)), JSON.stringify(args)).toBeNull();
    }
  });

  it("wraps the accepted figure in the environment the paper gets", () => {
    expect(figureEnvironment({ code: `\n${TIKZ}\n\n`, caption: " Training loss. ", label: "fig:loss" })).toBe([
      "\\begin{figure}[t]",
      "  \\centering",
      "  \\begin{tikzpicture}",
      "    \\draw (0,0) -- (1,1);",
      "  \\end{tikzpicture}",
      "  \\caption{Training loss.}",
      "  \\label{fig:loss}",
      "\\end{figure}",
    ].join("\n"));
    const wide = figureEnvironment({ code: "\\centering\n\\includegraphics{a}", caption: "A {wide} one.", label: "fig:a", placement: "tbp", wide: true });
    expect(wide.split("\n")).toEqual([
      "\\begin{figure*}[tbp]",
      "  \\centering",
      "  \\includegraphics{a}",
      "  \\caption{A {wide} one.}",
      "  \\label{fig:a}",
      "\\end{figure*}",
    ]);
    expect(() => figureEnvironment({ code: TIKZ, caption: "Only a caption." })).toThrow("caption and label");
    expect(() => figureEnvironment({ code: TIKZ, caption: "Unbalanced {", label: "fig:x" })).toThrow("braces");
  });

  describe("running", () => {
    beforeEach(() => {
      vi.mocked(invoke).mockReset();
      vi.mocked(getDocument).mockReset();
    });
    afterEach(() => vi.restoreAllMocks());

    it("answers a figure that does not typeset with its located errors and draws nothing", async () => {
      vi.mocked(invoke).mockResolvedValue(preview({
        pdf: null,
        errors: ["code line 2: Undefined control sequence. (at `\\draw (0,0) -- \\nowhere`)"],
      }));

      const result = await executeAgentFigureToolRequest(request({ lineWidth: "3.25in" }), "/papers/attention");

      expect(invoke).toHaveBeenCalledWith("preview_latex_figure", {
        projectRoot: "/papers/attention",
        request: { code: TIKZ, preamble: undefined, document: undefined, lineWidth: "3.25in" },
      });
      expect(result).toMatchObject({ type: "lattice:presentation-tool-result", id: "figure-1", ok: false });
      expect(result.error?.code).toBe("figure_build_failed");
      expect(result.error?.message).toContain("Fix this error, then preview again:\n\ncode line 2: Undefined control sequence.");
      expect(getDocument).not.toHaveBeenCalled();
    });

    it("returns the figure as a PNG with its size, the preamble it needs and the environment to insert", async () => {
      vi.mocked(invoke).mockResolvedValue(preview({ warnings: ["code line 3: 12pt wider than the line width"] }));
      const render = vi.fn(() => ({ promise: Promise.resolve() }));
      const destroy = vi.fn(async () => undefined);
      const page = {
        getViewport: ({ scale }: { scale: number }) => ({ width: 349 * scale, height: 124 * scale }),
        render,
      };
      vi.mocked(getDocument).mockReturnValue({
        promise: Promise.resolve({ getPage: async () => page }),
        destroy,
      } as unknown as ReturnType<typeof getDocument>);
      vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,iVBORw0KGgo=");

      const result = await executeAgentFigureToolRequest(
        request({ wide: true, caption: "Loss.", label: "fig:loss" }),
        "/papers/attention",
      );

      expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ request: { lineWidth: "\\textwidth" } });
      expect(result.ok).toBe(true);
      expect(result.result).toMatchObject({
        engine: "pdflatex",
        preambleFrom: "main.tex",
        preambleToAdd: ["\\usetikzlibrary{arrows.meta}"],
        warnings: ["code line 3: 12pt wider than the line width"],
        size: { widthPt: 345, heightPt: 120 },
        image: { mimeType: "image/png", width: 1047, height: 372, data: "iVBORw0KGgo=" },
      });
      expect(result.result?.figure).toMatch(/^\\begin\{figure\*\}\[t\]/);
      expect(result.result).not.toHaveProperty("preambleFallback");
      // Three pixels a point for a figure this small, on white.
      expect(render).toHaveBeenCalledWith(expect.objectContaining({ background: "#FFFFFF" }));
      expect(destroy).toHaveBeenCalled();
    });

    it("refuses before typesetting when there is no project or the request has expired", async () => {
      const closed = await executeAgentFigureToolRequest(request(), null);
      expect(closed.error?.code).toBe("figure_host_unavailable");
      const late = await executeAgentFigureToolRequest({ ...request(), expiresAt: Date.now() - 1 }, "/papers/attention");
      expect(late.error?.code).toBe("figure_tool_expired");
      expect(invoke).not.toHaveBeenCalled();
    });
  });
});
