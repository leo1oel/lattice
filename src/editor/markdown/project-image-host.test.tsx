import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectImageHostProvider, useProjectImage } from "./project-image-host";

function ImageProbe({ src, enabled = true }: { src: string; enabled?: boolean }) {
  const resolved = useProjectImage(src, enabled);
  return <span data-testid={src} data-resolved-length={resolved.src?.length ?? 0} data-target-existence={resolved.targetExistence} />;
}

function CacheHarness({ paths, loadAsset, revision = 0, enabled }: {
  paths: string[];
  loadAsset: (path: string) => Promise<string | null>;
  revision?: number;
  enabled?: boolean;
}) {
  return (
    <ProjectImageHostProvider activePath="notes/paper.md" loadAsset={loadAsset} revision={revision}>
      {paths.map((path) => <ImageProbe key={path} src={path} enabled={enabled} />)}
    </ProjectImageHostProvider>
  );
}

const resolvedLength = (value: string) => ["data-resolved-length", String(value.length)] as const;

describe("project image cache", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it.each([
    ["rejected", vi.fn().mockRejectedValueOnce(new Error("busy"))],
    ["null", vi.fn().mockResolvedValueOnce(null)],
  ])("retries a transient %s asset read while the image remains enabled", async (_name, loadAsset) => {
    vi.useFakeTimers();
    loadAsset.mockResolvedValue("data:image/png;base64,recovered");
    const view = render(<CacheHarness paths={["../figures/retry.png"]} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(view.getByTestId("../figures/retry.png"))
      .toHaveAttribute(...resolvedLength("data:image/png;base64,recovered")));
  });

  it.each([
    ["failing", async () => { throw new Error("missing"); }],
    ["null", async () => null],
  ])("bounds retries for a persistently %s asset read and reports it missing", async (_name, implementation) => {
    vi.useFakeTimers();
    const loadAsset = vi.fn(implementation);
    const path = "../figures/missing.png";
    const view = render(<CacheHarness paths={[path]} loadAsset={loadAsset} />);

    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(1_250);
    await vi.waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(3));
    await vi.waitFor(() => expect(view.getByTestId(path)).toHaveAttribute("data-target-existence", "missing"));
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loadAsset).toHaveBeenCalledTimes(3);
  });

  it("keeps a resolved image source after it leaves the preload viewport", async () => {
    vi.useFakeTimers();
    const loadAsset = vi.fn(async () => "data:image/png;base64,loaded");
    const paths = ["../figures/stable.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    const probe = view.getByTestId(paths[0]);

    await vi.waitFor(() => expect(probe).toHaveAttribute(...resolvedLength("data:image/png;base64,loaded")));
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled={false} />);
    expect(probe).toHaveAttribute(...resolvedLength("data:image/png;base64,loaded"));
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(probe).toHaveAttribute("data-resolved-length", "0"));
  });

  it("keeps the current image visible while a newer revision loads", async () => {
    let finishRefresh!: (value: string) => void;
    const loadAsset = vi.fn()
      .mockResolvedValueOnce("data:image/png;base64,current")
      .mockReturnValueOnce(new Promise<string>((resolve) => { finishRefresh = resolve; }));
    const paths = ["../figures/stable-during-refresh.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    const probe = view.getByTestId(paths[0]);

    await waitFor(() => expect(probe).toHaveAttribute(...resolvedLength("data:image/png;base64,current")));
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} revision={1} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
    expect(probe).toHaveAttribute(...resolvedLength("data:image/png;base64,current"));

    finishRefresh("data:image/png;base64,refreshed");
    await waitFor(() => expect(probe).toHaveAttribute(...resolvedLength("data:image/png;base64,refreshed")));
  });

  it("does not retain one decoded source larger than the cache budget", async () => {
    const oversized = `data:image/png;base64,${"a".repeat(24 * 1024 * 1024 + 1)}`;
    const loadAsset = vi.fn(async () => oversized);
    const paths = ["../figures/large.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await waitFor(() => expect(view.getByTestId(paths[0])).toHaveAttribute(...resolvedLength(oversized)));
    expect(loadAsset).toHaveBeenCalledTimes(1);
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    expect(loadAsset).toHaveBeenCalledTimes(1);
    view.unmount();
    render(<CacheHarness paths={paths} loadAsset={loadAsset} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
  });

  it.each([
    ["resolved", (path: string) => Promise.resolve(`data:image/png;base64,${path}`), 49],
    ["abandoned pending", () => new Promise<string | null>(() => undefined), 1],
  ])("evicts %s reads beyond the bounded cache", async (_name, implementation, remounted) => {
    const paths = Array.from({ length: 49 }, (_, index) => `../figures/${_name}-${index}.png`);
    const loadAsset = vi.fn(implementation);
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(49));
    view.unmount();
    render(<CacheHarness paths={paths.slice(0, remounted)} loadAsset={loadAsset} />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(50));
  });
});
