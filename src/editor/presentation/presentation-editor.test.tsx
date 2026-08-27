import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PresentationEditor, type PresentationEditorProps } from "./presentation-editor";

const revealMock = vi.hoisted(() => ({
  initializeImpl: null as null | (() => Promise<void>),
  options: [] as Array<Record<string, unknown>>,
  instances: [] as Array<{
    configure: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
    initialize: ReturnType<typeof vi.fn>;
    layout: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    on: ReturnType<typeof vi.fn>;
    slide: ReturnType<typeof vi.fn>;
    sync: ReturnType<typeof vi.fn>;
  }>,
}));
const notificationMock = vi.hoisted(() => ({ error: vi.fn() }));
const platformMock = vi.hoisted(() => ({ browserHosted: false }));
const tauriMock = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("reveal.js", () => ({
  default: class MockReveal {
    configure = vi.fn();
    destroy = vi.fn();
    initialize = vi.fn(() => revealMock.initializeImpl?.() ?? Promise.resolve());
    layout = vi.fn();
    off = vi.fn();
    on = vi.fn();
    slide = vi.fn();
    sync = vi.fn();

    constructor(_root: unknown, options: Record<string, unknown>) {
      revealMock.options.push(options);
      revealMock.instances.push(this);
    }
  },
}));
vi.mock("reveal.js/plugin/highlight", () => ({ default: {} }));
vi.mock("reveal.js/plugin/notes", () => ({ default: {} }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: tauriMock.invoke }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
vi.mock("../../platform/browser-runtime", () => ({
  isBrowserHosted: () => platformMock.browserHosted,
}));
vi.mock("../../telemetry/app-notify", () => ({ notifyError: notificationMock.error }));
vi.mock("../codemirror-host", () => ({
  CodeMirrorHost: (props: {
    className?: string;
    value: string;
    editable?: boolean;
    extensions: unknown[];
    onChange: (value: string) => void;
  }) => (
    <div className={props.className} data-extension-count={props.extensions.length}>
      <textarea
        aria-label="Presentation Markdown source"
        value={props.value}
        readOnly={props.editable === false}
        onChange={(event) => props.onChange(event.target.value)}
      />
    </div>
  ),
}));

const DEFAULT_SOURCE = "# Opening\n\nHello\n\n---\n\n## Details\n\n- One\n- Two\n";
const originalFullscreenElement = Object.getOwnPropertyDescriptor(document, "fullscreenElement");
const originalRequestFullscreen = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  "requestFullscreen",
);

function Harness(props: Partial<PresentationEditorProps> = {}) {
  const [source, setSource] = useState(props.source ?? DEFAULT_SOURCE);
  return (
    <PresentationEditor
      {...props}
      path={props.path ?? "talk.slides.md"}
      source={source}
      onChange={(next) => {
        setSource(next);
        props.onChange?.(next);
      }}
      onPersist={props.onPersist ?? vi.fn(async () => true)}
    />
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  if (originalFullscreenElement) {
    Object.defineProperty(document, "fullscreenElement", originalFullscreenElement);
  } else {
    Reflect.deleteProperty(document, "fullscreenElement");
  }
  if (originalRequestFullscreen) {
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", originalRequestFullscreen);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, "requestFullscreen");
  }
});

beforeEach(() => {
  revealMock.initializeImpl = null;
  revealMock.options.length = 0;
  revealMock.instances.length = 0;
  platformMock.browserHosted = false;
  vi.clearAllMocks();
  tauriMock.invoke.mockResolvedValue(false);
  vi.spyOn(window, "print").mockImplementation(() => undefined);
});

describe("PresentationEditor", () => {
  it("keeps one Reveal instance, synchronizes edits, and destroys it on unmount", async () => {
    const { unmount } = render(<Harness />);

    await waitFor(() => expect(revealMock.instances).toHaveLength(1));
    const reveal = revealMock.instances[0];
    await waitFor(() => expect(reveal.initialize).toHaveBeenCalledOnce());
    expect(revealMock.options[0]).toMatchObject({ controls: false, slideNumber: false });

    fireEvent.change(screen.getByRole("textbox", { name: "Presentation Markdown source" }), {
      target: { value: `${DEFAULT_SOURCE}\n---\n\n## Ending\n` },
    });
    await waitFor(() => expect(reveal.sync).toHaveBeenCalled());
    expect(revealMock.instances).toHaveLength(1);

    unmount();
    expect(reveal.destroy).toHaveBeenCalledOnce();
  });

  it("synchronizes the latest source and settings after delayed Reveal initialization", async () => {
    let finishInitialization: (() => void) | undefined;
    revealMock.initializeImpl = () => new Promise<void>((resolve) => {
      finishInitialization = resolve;
    });
    render(<Harness />);
    await waitFor(() => expect(revealMock.instances[0]?.initialize).toHaveBeenCalledOnce());
    await new Promise((resolve) => window.requestAnimationFrame(resolve));
    expect(revealMock.instances[0].layout).not.toHaveBeenCalled();

    fireEvent.pointerDown(screen.getByRole("button", { name: "Presentation style" }), {
      button: 0,
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByRole("menuitemradio", { name: "Zoom" }));
    await waitFor(() => expect((screen.getByRole("textbox", {
      name: "Presentation Markdown source",
    }) as HTMLTextAreaElement).value).toContain("transition: zoom"));

    finishInitialization?.();
    await waitFor(() => expect(revealMock.instances[0].configure).toHaveBeenCalledWith({
      keyboard: true,
      transition: "zoom",
    }));
    expect(revealMock.instances[0].sync).toHaveBeenCalledOnce();
  });

  it("resynchronizes Reveal after a hidden preview becomes visible", async () => {
    const { rerender } = render(<Harness mode="source" />);
    await waitFor(() => expect(revealMock.instances[0]?.initialize).toHaveBeenCalledOnce());
    await waitFor(() => expect(revealMock.instances[0]?.sync).toHaveBeenCalled());
    const reveal = revealMock.instances[0];
    reveal.sync.mockClear();
    reveal.layout.mockClear();

    rerender(<Harness mode="split" />);

    await waitFor(() => expect(reveal.sync).toHaveBeenCalled());
    await waitFor(() => expect(reveal.layout).toHaveBeenCalled());
  });

  it("does not leave pointer focus on the presentation style trigger when its menu closes", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Presentation style" });

    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    await screen.findByRole("menuitemradio", { name: "Lattice" });
    trigger.focus();
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });

    await waitFor(() => expect(screen.queryByRole("menuitemradio", { name: "Lattice" })).not.toBeInTheDocument());
    expect(trigger).not.toHaveFocus();
  });

  it("adds a slide, navigates, and persists the selected view", async () => {
    const onChange = vi.fn();
    const onViewState = vi.fn();
    render(<Harness onChange={onChange} onViewState={onViewState} />);
    await waitFor(() => expect(revealMock.instances[0]?.initialize).toHaveBeenCalled());

    fireEvent.click(screen.getByRole("button", { name: "Add slide" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.stringContaining("# New slide")));

    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    await waitFor(() => expect(onViewState).toHaveBeenCalledWith({
      slide: 0,
      mode: "split",
      thumbnailRailOpen: true,
      thumbnailRailWidth: 176,
      splitRatio: 0.5,
    }));
    expect(revealMock.instances[0].slide).toHaveBeenCalledWith(0);
  });

  it("uses the shared source editor styling and lets users resize the split", async () => {
    const { container } = render(<Harness languageExtensions={[{} as never]} />);
    const source = container.querySelector(".presentation-source");
    expect(source).toHaveClass("source-editor");
    expect(source?.querySelector(".code-editor-root")).toHaveAttribute("data-extension-count", "3");

    const stage = container.querySelector<HTMLElement>(".presentation-stage")!;
    vi.spyOn(stage, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 1000,
      bottom: 700,
      width: 1000,
      height: 700,
      toJSON: () => ({}),
    });
    const separator = screen.getByRole("separator", { name: "Resize source and presentation preview" });
    fireEvent.pointerDown(separator, { clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 650 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "65"));

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "62"));

    fireEvent.pointerDown(separator, { clientX: 620 });
    fireEvent.pointerMove(window, { clientX: 900 });
    fireEvent.pointerUp(window);
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "66"));
  });

  it("cleans up a split resize if the editor unmounts mid-drag", () => {
    const { unmount } = render(<Harness />);
    const separator = screen.getByRole("separator", { name: "Resize source and presentation preview" });
    fireEvent.pointerDown(separator, { clientX: 500 });
    expect(document.body).toHaveClass("resizing-split");

    unmount();
    expect(document.body).not.toHaveClass("resizing-split");
  });

  it("navigates with a collapsible slide directory and persists its state", async () => {
    const onViewState = vi.fn();
    const { container } = render(<Harness onViewState={onViewState} />);
    expect(screen.getByRole("navigation", { name: "Slides" })).toBeInTheDocument();
    expect(container.querySelector(".presentation-thumbnails")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Slide 2: Details" }));
    expect(revealMock.instances[0].slide).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByRole("button", { name: "Hide slide navigator" }));
    expect(screen.queryByRole("navigation", { name: "Slides" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show slide navigator" })).toBeInTheDocument();
    await waitFor(() => expect(onViewState).toHaveBeenLastCalledWith({
      slide: 1,
      mode: "split",
      thumbnailRailOpen: false,
      thumbnailRailWidth: 176,
      splitRatio: 0.5,
    }));
  });

  it("renders each directory item as a scaled copy of the slide", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function getClientWidth(this: HTMLElement) {
        return this.classList.contains("presentation-thumbnail-card") ? 136 : 0;
      },
    );
    const onLoadAsset = vi.fn(async () => "data:image/png;base64,YQ==");
    const source = [
      "## Next Slide",
      "",
      "A concise explanation.",
      "",
      "![Plot](../figures/plot.png)",
    ].join("\n");
    const { container } = render(
      <Harness
        path="decks/talk.slides.md"
        source={source}
        onLoadAsset={onLoadAsset}
      />,
    );
    const thumbnail = screen.getByRole("button", { name: "Slide 1: Next Slide" });

    expect(thumbnail.textContent?.match(/Next Slide/g)).toHaveLength(1);
    expect(thumbnail.querySelector(".presentation-thumbnail-canvas")).toBeInTheDocument();
    expect(thumbnail.querySelector(".presentation-thumbnail-reveal")).toHaveAttribute("inert");
    expect(container.querySelector<HTMLElement>(".presentation-thumbnail-list")?.style.getPropertyValue(
      "--presentation-thumbnail-scale",
    )).toBe("0.085");
    const thumbnailSlide = thumbnail.querySelector<HTMLElement>(".presentation-slide-surface");
    const previewSlide = container.querySelector<HTMLElement>(
      ".presentation-preview .presentation-slide-surface",
    );
    expect(thumbnailSlide).toHaveAttribute("data-layout", "media");
    expect(previewSlide).toHaveAttribute("data-layout", "media");
    await waitFor(() => {
      expect(thumbnailSlide?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,YQ==");
      expect(previewSlide?.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,YQ==");
    });
    expect(thumbnailSlide?.querySelector(".presentation-slide-content")?.innerHTML).toBe(
      previewSlide?.querySelector(".presentation-slide-content")?.innerHTML,
    );
  });

  it("keeps a loaded project image through later source renders", async () => {
    const dataUrl = "data:image/png;base64,YQ==";
    const onLoadAsset = vi.fn(async () => dataUrl);
    const source = "## Result\n\n![Plot](figures/plot.png)\n\nInitial explanation.";
    const { container } = render(<Harness source={source} onLoadAsset={onLoadAsset} />);

    await waitFor(() => {
      const images = container.querySelectorAll<HTMLImageElement>("img");
      expect(images).toHaveLength(2);
      for (const image of images) expect(image).toHaveAttribute("src", dataUrl);
    });
    const callsAfterLoad = onLoadAsset.mock.calls.length;

    fireEvent.change(screen.getByRole("textbox", { name: "Presentation Markdown source" }), {
      target: { value: source.replace("Initial explanation.", "Updated explanation.") },
    });

    await waitFor(() => expect(container.querySelector(".presentation-preview")).toHaveTextContent(
      "Updated explanation.",
    ));
    for (const image of container.querySelectorAll<HTMLImageElement>("img")) {
      expect(image).toHaveAttribute("src", dataUrl);
    }
    expect(onLoadAsset).toHaveBeenCalledTimes(callsAfterLoad);
  });

  it("hydrates project images after the initially rendered nodes are replaced", async () => {
    let finishLoading: ((dataUrl: string) => void) | undefined;
    const onLoadAsset = vi.fn(() => new Promise<string>((resolve) => {
      finishLoading = resolve;
    }));
    const { container } = render(
      <Harness source="## Result\n\n![MMVP Phase Portrait](figures/mmvp.png)" onLoadAsset={onLoadAsset} />,
    );
    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith("figures/mmvp.png"));
    const reveal = revealMock.instances[0];
    await waitFor(() => expect(reveal?.sync).toHaveBeenCalled());
    reveal.sync.mockClear();

    for (const image of container.querySelectorAll("img")) image.remove();
    finishLoading?.("data:image/png;base64,YQ==");

    await waitFor(() => {
      const images = container.querySelectorAll<HTMLImageElement>("img");
      expect(images).toHaveLength(2);
      for (const image of images) {
        expect(image).toHaveAttribute("src", "data:image/png;base64,YQ==");
      }
    });
    await waitFor(() => expect(reveal.sync).toHaveBeenCalled());
  });

  it("loads each relative image path once for a multi-image deck", async () => {
    const onLoadAsset = vi.fn(async (path: string) => (
      `data:image/png;base64,${btoa(path)}`
    ));
    const source = [
      "## MMVP",
      "",
      "![MMVP Phase Portrait](figures/mmvp_prefix_suffix_retained_pair_accuracy_plotly.png)",
      "",
      "---",
      "",
      "## Retention",
      "",
      "![Caption Feature Retention](figures/figure1_feature_retention.png)",
    ].join("\n");
    const { container } = render(<Harness source={source} onLoadAsset={onLoadAsset} />);

    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledTimes(2));
    expect(onLoadAsset).toHaveBeenCalledWith(
      "figures/mmvp_prefix_suffix_retained_pair_accuracy_plotly.png",
    );
    expect(onLoadAsset).toHaveBeenCalledWith("figures/figure1_feature_retention.png");
    await waitFor(() => {
      const images = container.querySelectorAll<HTMLImageElement>("img");
      expect(images).toHaveLength(4);
      for (const image of images) expect(image.src).toMatch(/^data:image\/png;base64,/);
    });
  });

  it("uses title and media layouts for common slide structures", () => {
    const source = [
      "# Opening",
      "",
      "A concise subtitle",
      "",
      "---",
      "",
      "## Result",
      "",
      "![Plot](figures/plot.png)",
      "",
      "The result improves on the baseline.",
    ].join("\n");
    const { container } = render(<Harness source={source} />);
    const slides = container.querySelectorAll(".presentation-preview .reveal .slides > section");

    expect(slides[0]).toHaveAttribute("data-layout", "title");
    expect(slides[1]).toHaveAttribute("data-layout", "media");
    expect(slides[1].querySelector(".presentation-slide-content")).not.toBeNull();
  });

  it("retries a transient project image miss", async () => {
    const onLoadAsset = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("data:image/png;base64,YQ==");
    render(
      <Harness
        source="## Result\n\n![Plot](figures/plot.png)"
        onLoadAsset={onLoadAsset}
        initialViewState={{
          slide: 0,
          mode: "preview",
          thumbnailRailOpen: false,
          thumbnailRailWidth: 176,
          splitRatio: 0.5,
        }}
      />,
    );

    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
      "src",
      "data:image/png;base64,YQ==",
    ));
  });

  it("resizes the slide directory with pointer and keyboard controls", async () => {
    const onViewState = vi.fn();
    const { container } = render(<Harness onViewState={onViewState} />);
    const workspace = container.querySelector<HTMLElement>(".presentation-workspace")!;
    vi.spyOn(workspace, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 900,
      bottom: 700,
      width: 900,
      height: 700,
      toJSON: () => ({}),
    });
    const separator = screen.getByRole("separator", { name: "Resize slide navigator" });

    fireEvent.pointerDown(separator, { clientX: 176 });
    fireEvent.pointerMove(window, { clientX: 220 });
    expect(workspace.style.getPropertyValue("--presentation-thumbnail-width")).toBe("220px");
    fireEvent.pointerUp(window);
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "220"));
    await waitFor(() => expect(onViewState).toHaveBeenLastCalledWith({
      slide: 0,
      mode: "split",
      thumbnailRailOpen: true,
      thumbnailRailWidth: 220,
      splitRatio: 0.5,
    }));

    fireEvent.keyDown(separator, { key: "ArrowLeft" });
    await waitFor(() => expect(separator).toHaveAttribute("aria-valuenow", "208"));
  });

  it("hides preview navigation and the slide directory in source mode", () => {
    render(<Harness initialViewState={{ slide: 0, mode: "source" }} />);

    expect(screen.queryByRole("button", { name: "Previous slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Next slide" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Slides" })).not.toBeInTheDocument();
    expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();
  });

  it("places compact arrows at the preview start and accepts a direct slide number", async () => {
    render(<Harness />);
    const navigation = screen.getByLabelText("Slide navigation");
    const previous = screen.getByRole("button", { name: "Previous slide" });
    const next = screen.getByRole("button", { name: "Next slide" });
    const page = screen.getByRole("textbox", { name: "Slide number" });

    expect(previous.closest(".presentation-preview-navigation-start")).not.toBeNull();
    expect(next.closest(".presentation-preview-navigation-start")).not.toBeNull();
    expect(page.closest(".presentation-preview-navigation")).toBe(navigation);
    expect(page).toHaveValue("1");
    expect(screen.queryByText("1 / 2")).not.toBeInTheDocument();

    fireEvent.click(next);
    await waitFor(() => expect(page).toHaveValue("2"));
    fireEvent.focus(page);
    fireEvent.change(page, { target: { value: "1" } });
    fireEvent.blur(page);
    await waitFor(() => expect(page).toHaveValue("1"));
    expect(revealMock.instances[0].slide).toHaveBeenCalledWith(0);
  });

  it("navigates one slide per vertical wheel gesture", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    render(<Harness />);
    const preview = screen.getByLabelText("Presentation preview").closest(".presentation-preview")!;
    const page = screen.getByRole("textbox", { name: "Slide number" });

    fireEvent.wheel(preview, { deltaX: 0, deltaY: 100, deltaMode: 0 });
    await waitFor(() => expect(page).toHaveValue("2"));

    now.mockReturnValue(1_100);
    fireEvent.wheel(preview, { deltaX: 0, deltaY: -100, deltaMode: 0 });
    expect(page).toHaveValue("2");

    now.mockReturnValue(1_400);
    fireEvent.wheel(preview, { deltaX: 0, deltaY: -100, deltaMode: 0 });
    await waitFor(() => expect(page).toHaveValue("1"));
  });

  it("deletes the selected slide from the toolbar", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Delete slide" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.not.stringContaining("# Opening")));
    expect(screen.getAllByText("Details").length).toBeGreaterThan(0);
  });

  it("deletes the requested slide from its context menu", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);

    fireEvent.contextMenu(screen.getByRole("button", { name: "Slide 2: Details" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete slide" }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(expect.not.stringContaining("## Details")));
  });

  it("saves before opening the native print panel and restores source mode", async () => {
    const onPersist = vi.fn(async () => true);
    const { container } = render(
      <Harness
        onPersist={onPersist}
        initialViewState={{ slide: 0, mode: "source" }}
      />,
    );
    tauriMock.invoke.mockImplementation(async (command: string) => {
      expect(command).toBe("print_webview");
      expect(document.documentElement).toHaveClass("lattice-presentation-print");
      expect(container.querySelector(".presentation-editor")).toHaveAttribute(
        "data-presentation-printing",
        "true",
      );
      return false;
    });

    fireEvent.click(screen.getByRole("button", { name: "Print / PDF" }));
    await waitFor(() => expect(tauriMock.invoke).toHaveBeenCalledWith("print_webview"));
    expect(onPersist).toHaveBeenCalledOnce();
    expect(window.print).not.toHaveBeenCalled();
    await waitFor(() => expect(document.documentElement).not.toHaveClass("lattice-presentation-print"));
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Presentation Markdown source",
    })).toBeInTheDocument());
  });

  it("uses the visible browser print dialog in browser-hosted workspaces", async () => {
    platformMock.browserHosted = true;
    const { container } = render(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Print / PDF" }));
    await waitFor(() => expect(window.print).toHaveBeenCalledOnce());
    expect(tauriMock.invoke).not.toHaveBeenCalled();
    expect(document.documentElement).toHaveClass("lattice-presentation-print");
    expect(container.querySelector(".presentation-editor")).toHaveAttribute(
      "data-presentation-printing",
      "true",
    );

    window.dispatchEvent(new Event("afterprint"));
    expect(document.documentElement).not.toHaveClass("lattice-presentation-print");
  });

  it("reports a native print failure and restores the editor", async () => {
    tauriMock.invoke.mockRejectedValue(new Error("print unavailable"));
    render(<Harness initialViewState={{ slide: 0, mode: "source" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Print / PDF" }));
    await waitFor(() => expect(notificationMock.error).toHaveBeenCalledWith(
      "Presentation",
      "Could not open the print dialog",
      { detail: "print unavailable" },
    ));
    expect(document.documentElement).not.toHaveClass("lattice-presentation-print");
    expect(screen.getByRole("textbox", {
      name: "Presentation Markdown source",
    })).toBeInTheDocument();
  });

  it("requests fullscreen during the source-mode click and manages presentation focus", async () => {
    let fullscreenElement: Element | null = null;
    Object.defineProperty(document, "fullscreenElement", {
      configurable: true,
      get: () => fullscreenElement,
    });
    const requestFullscreen = vi.fn(() => {
      fullscreenElement = document.querySelector(".presentation-preview");
      document.dispatchEvent(new Event("fullscreenchange"));
      return Promise.resolve();
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    render(<Harness initialViewState={{ slide: 0, mode: "source" }} />);
    const presentButton = screen.getByRole("button", { name: "Present" });

    fireEvent.click(presentButton);
    expect(requestFullscreen).toHaveBeenCalledOnce();
    await waitFor(() => expect(screen.getByLabelText("Presentation preview")).toHaveFocus());

    fireEvent.click(screen.getByLabelText("Presentation preview"));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Slide number" })).toHaveValue("2"));
    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    await waitFor(() => expect(screen.getByRole("textbox", { name: "Slide number" })).toHaveValue("1"));

    fullscreenElement = null;
    document.dispatchEvent(new Event("fullscreenchange"));
    expect(presentButton).toHaveFocus();
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Presentation Markdown source",
    })).toBeInTheDocument());
  });

  it("handles denied fullscreen without disrupting the editor", async () => {
    const requestFullscreen = vi.fn(async () => {
      throw new Error("denied");
    });
    Object.defineProperty(HTMLElement.prototype, "requestFullscreen", {
      configurable: true,
      value: requestFullscreen,
    });
    render(<Harness initialViewState={{ slide: 0, mode: "source" }} />);

    fireEvent.click(screen.getByRole("button", { name: "Present" }));
    await waitFor(() => expect(requestFullscreen).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.getByRole("textbox", {
      name: "Presentation Markdown source",
    })).toBeInTheDocument());
  });

  it("sanitizes markup, hydrates local images, and routes links safely", async () => {
    const onLoadAsset = vi.fn(async () => "data:image/png;base64,YQ==");
    const onOpenProjectPath = vi.fn();
    const source = [
      "# Links",
      "",
      "<script>window.pwned = true</script>",
      "",
      "[Website](https://example.com/path)",
      "",
      "[Notes](./notes.md)",
      "",
      "[Unsafe](javascript:alert(1))",
      "",
      "![Plot](../figures/plot.png)",
    ].join("\n");
    const { container } = render(
      <Harness
        path="decks/talk.slides.md"
        source={source}
        onLoadAsset={onLoadAsset}
        onOpenProjectPath={onOpenProjectPath}
      />,
    );

    const preview = container.querySelector<HTMLElement>(".presentation-preview")!;
    expect(container.querySelector("script")).toBeNull();
    expect(Array.from(preview.querySelectorAll("a")).find((link) => link.textContent === "Unsafe"))
      .not.toHaveAttribute("href");
    await waitFor(() => expect(onLoadAsset).toHaveBeenCalledWith("figures/plot.png"));
    await waitFor(() => expect(screen.getByRole("img", { name: "Plot" })).toHaveAttribute(
      "src",
      "data:image/png;base64,YQ==",
    ));

    fireEvent.click(screen.getByRole("link", { name: "Website" }));
    expect(openUrl).toHaveBeenCalledWith("https://example.com/path");
    fireEvent.click(screen.getByRole("link", { name: "Notes" }));
    expect(onOpenProjectPath).toHaveBeenCalledWith("decks/notes.md");
  });
});
