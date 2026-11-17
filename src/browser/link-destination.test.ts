import { openUrl } from "@tauri-apps/plugin-opener";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserPanel, linkDestination, openAgentWebLink } from "./link-destination";

const host = vi.hoisted(() => ({ label: "main" as string | undefined }));
vi.mock("../app/project-tab-window", () => ({ nativeProjectTabWindow: () => host.label }));
vi.mock("../platform/host-platform", () => ({ hostPlatform: () => "mac" }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn(async () => undefined) }));
const url = "https://example.com/private";

afterEach(() => {
  browserPanel.setState({ request: null });
  localStorage.clear();
  host.label = "main";
  vi.clearAllMocks();
});

describe("agent web links", () => {
  it("starts with the default browser and follows the saved panel preference", () => {
    openAgentWebLink(url, undefined);
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
    linkDestination.set("panel");
    openAgentWebLink(url, undefined);
    expect(browserPanel.getState().request).toEqual({ url });
    expect(openUrl).toHaveBeenCalledTimes(1);
  });

  it("honors a one-link override in either direction", () => {
    linkDestination.set("external");
    openAgentWebLink(url, "panel");
    expect(browserPanel.getState().request).toEqual({ url });
    linkDestination.set("panel");
    openAgentWebLink(url, "external");
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
  });

  it("opens externally when the desktop panel is unavailable and rejects non-web links", () => {
    host.label = undefined;
    openAgentWebLink(url, "panel");
    openAgentWebLink("file:///tmp/private", "external");
    expect(openUrl).toHaveBeenCalledExactlyOnceWith(url);
    expect(browserPanel.getState().request).toBeNull();
  });
});
