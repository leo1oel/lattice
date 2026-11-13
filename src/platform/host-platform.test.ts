import { expect, it, vi } from "vitest";
import { hostPlatform, isWindowsHost } from "./host-platform";

it("tells the three desktops apart by user agent, and takes anything else for a Mac", () => {
  const userAgent = vi.spyOn(navigator, "userAgent", "get");
  const host = (agent: string) => {
    userAgent.mockReturnValue(agent);
    return hostPlatform();
  };
  try {
    expect(host("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)")).toBe("mac");
    expect(host("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Edg/140.0")).toBe("windows");
    expect(isWindowsHost()).toBe(true);
    // The AppImage's WebKitGTK window, and a desktop browser on the web demo.
    expect(host("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15")).toBe("linux");
    expect(isWindowsHost()).toBe(false);
    // Neither is the Linux desktop: a phone opening the web demo, and jsdom under a Linux CI runner.
    expect(host("Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36")).toBe("mac");
    expect(host("Mozilla/5.0 (linux) AppleWebKit/537.36 (KHTML, like Gecko) jsdom/27.0.0")).toBe("mac");
  } finally { userAgent.mockRestore(); }
});
