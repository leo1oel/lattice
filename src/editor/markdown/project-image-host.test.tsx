import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectImageHostProvider, useProjectImage } from "./project-image-host";

function ImageProbe({ src, enabled = true }: { src: string; enabled?: boolean }) {
  const resolved = useProjectImage(src, enabled);
  return (
    <span
      data-testid={src}
      data-resolved-length={resolved.src?.length ?? 0}
      data-target-existence={resolved.targetExistence}
    />
  );
}

function CacheHarness({
  paths,
  loadAsset,
  revision = 0,
}: {
  paths: string[];
  loadAsset: (path: string) => Promise<string | null>;
  revision?: number;
}) {
  return (
    <ProjectImageHostProvider
      activePath="notes/paper.md"
      loadAsset={loadAsset}
      revision={revision}
    >
      {paths.map((path) => <ImageProbe key={path} src={path} />)}
    </ProjectImageHostProvider>
  );
}

describe("project image cache", () => {
  it("retries a transient asset read while the image remains enabled", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValue("data:image/png;base64,recovered");
    const paths = ["../figures/retry.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.getByTestId(paths[0])).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,recovered".length),
    ));
    vi.useRealTimers();
  });

  it("retries a transient null asset result instead of caching a blank image", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue("data:image/png;base64,recovered");
    const paths = ["../figures/not-ready.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.getByTestId(paths[0])).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,recovered".length),
    ));
    vi.useRealTimers();
  });

  it("bounds retries for a persistently failing asset read", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn(async () => { throw new Error("missing"); });
    const path = "../figures/missing.png";
    const view = render(<CacheHarness paths={[path]} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(view.getByTestId(path)).toHaveAttribute(
      "data-target-existence",
      "missing",
    ));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadAsset).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it("reports a persistently null project asset as missing", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn(async () => null);
    const path = "../figures/permanently-missing.png";
    const view = render(<CacheHarness paths={[path]} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(view.getByTestId(path)).toHaveAttribute(
      "data-target-existence",
      "missing",
    ));
    vi.useRealTimers();
  });

  it("keeps a resolved image source after it leaves the preload viewport", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn(async () => "data:image/png;base64,loaded");
    const view = render(
      <ProjectImageHostProvider activePath="notes/paper.md" loadAsset={loadAsset}>
        <ImageProbe src="../figures/stable.png" />
      </ProjectImageHostProvider>,
    );

    const probe = view.getByTestId("../figures/stable.png");
    await vi.waitFor(() => expect(probe).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,loaded".length),
    ));
    view.rerender(
      <ProjectImageHostProvider activePath="notes/paper.md" loadAsset={loadAsset}>
        <ImageProbe src="../figures/stable.png" enabled={false} />
      </ProjectImageHostProvider>,
    );
    expect(probe).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,loaded".length),
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(probe).toHaveAttribute("data-resolved-length", "0"));
    vi.useRealTimers();
  });

  it("keeps the current image visible while a newer revision loads", async () => {
    let finishRefresh!: (value: string) => void;
    const refreshed = new Promise<string>((resolve) => { finishRefresh = resolve; });
    const loadAsset = vi.fn()
      .mockResolvedValueOnce("data:image/png;base64,current")
      .mockReturnValueOnce(refreshed);
    const path = "../figures/stable-during-refresh.png";
    const view = render(<CacheHarness paths={[path]} loadAsset={loadAsset} />);
    const probe = view.getByTestId(path);

    await waitFor(() => expect(probe).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,current".length),
    ));
    view.rerender(<CacheHarness paths={[path]} loadAsset={loadAsset} revision={1} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
    expect(probe).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,current".length),
    );

    finishRefresh("data:image/png;base64,refreshed");
    await waitFor(() => expect(probe).toHaveAttribute(
      "data-resolved-length",
      String("data:image/png;base64,refreshed".length),
    ));
  });

  it("does not retain one decoded source larger than the cache budget", async () => {
    const oversized = `data:image/png;base64,${"a".repeat(24 * 1024 * 1024 + 1)}`;
    const loadAsset = vi.fn(async () => oversized);
    const paths = ["../figures/large.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByTestId(paths[0])).toHaveAttribute(
      "data-resolved-length",
      String(oversized.length),
    ));
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    expect(loadAsset).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
  });

  it("bounds pending and resolved cache entries", async () => {
    const paths = Array.from({ length: 49 }, (_, index) => `../figures/${index}.png`);
    const loadAsset = vi.fn(async (path: string) => `data:image/png;base64,${path}`);
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(49));
    view.unmount();
    render(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(50));
  });

  it("evicts abandoned pending reads from the bounded cache", async () => {
    const paths = Array.from({ length: 49 }, (_, index) => `../figures/pending-${index}.png`);
    const loadAsset = vi.fn(() => new Promise<string | null>(() => undefined));
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(49));
    view.unmount();
    render(<CacheHarness paths={[paths[0]]} loadAsset={loadAsset} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(50));
  });
});
