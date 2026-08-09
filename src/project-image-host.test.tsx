import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ProjectImageHostProvider, useProjectImageSrc } from "./project-image-host";

function ImageProbe({ src, enabled }: { src: string; enabled: boolean }) {
  const resolved = useProjectImageSrc(src, enabled);
  return <span data-testid={src} data-resolved-length={resolved?.length ?? 0} />;
}

function CacheHarness({
  paths,
  loadAsset,
  enabled,
}: {
  paths: string[];
  loadAsset: (path: string) => Promise<string | null>;
  enabled: boolean;
}) {
  return (
    <ProjectImageHostProvider activePath="notes/paper.md" loadAsset={loadAsset}>
      {paths.map((path) => <ImageProbe key={path} src={path} enabled={enabled} />)}
    </ProjectImageHostProvider>
  );
}

describe("project image cache", () => {
  it("does not retain one decoded source larger than the cache budget", async () => {
    const oversized = `data:image/png;base64,${"a".repeat(24 * 1024 * 1024 + 1)}`;
    const loadAsset = vi.fn(async () => oversized);
    const paths = ["../figures/large.png"];
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} enabled />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByTestId(paths[0])).toHaveAttribute(
      "data-resolved-length",
      String(oversized.length),
    ));
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled />);
    expect(loadAsset).toHaveBeenCalledTimes(1);
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled={false} />);
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(2));
  });

  it("bounds pending and resolved cache entries", async () => {
    const paths = Array.from({ length: 49 }, (_, index) => `../figures/${index}.png`);
    const loadAsset = vi.fn(async (path: string) => `data:image/png;base64,${path}`);
    const view = render(<CacheHarness paths={paths} loadAsset={loadAsset} enabled />);

    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(49));
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled={false} />);
    view.rerender(<CacheHarness paths={paths} loadAsset={loadAsset} enabled />);
    await waitFor(() => expect(loadAsset).toHaveBeenCalledTimes(50));
  });
});
