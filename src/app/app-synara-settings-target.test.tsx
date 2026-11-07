import { projectCommands, findFrame, findSettingsDialog, nextFrames, openAgentFrame, postWindowMessage } from "./app-test-utils";
import { appHarness } from "./app-test-mount";
import { settingsDialog } from "./app-test-settings";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";

const { renderApp } = appHarness({ settingsDialog });

// The Agent panel's no-agent notice ("Set path…") asks for Claude Code's and Codex's
// binary paths; the frame opens them and says where they are, and Settings scrolls there.
it("opens Providers on the binary paths the Agent panel asks for, and scrolls to them", async () => {
  renderApp(projectCommands());
  const { frame: agentFrame } = await openAgentFrame();
  postWindowMessage(agentFrame.contentWindow, { type: "synara:open-settings", section: "providers", target: "provider-binary-paths" });
  await findSettingsDialog(10_000);
  const frame = await findFrame("Synara Providers settings");
  const posted = vi.spyOn(frame.contentWindow!, "postMessage");
  const requests = () => posted.mock.calls.map(([data]) => data as { type: string; section: string; request: number; target?: string })
    .filter((data) => data.type === "lattice:set-settings-section");
  postWindowMessage(frame.contentWindow, { type: "synara:embed-ready" });
  await waitFor(() => expect(requests()).toEqual([expect.objectContaining({ section: "providers", target: "provider-binary-paths" })]));
  postWindowMessage(frame.contentWindow, { type: "synara:settings-section-ready", section: "providers", request: requests()[0].request });
  const embed = frame.closest<HTMLElement>(".synara-settings-embed")!;
  await waitFor(() => expect(embed).toHaveAttribute("data-ready", "true"));

  const scrollTo = vi.fn();
  const original = HTMLElement.prototype.scrollTo;
  HTMLElement.prototype.scrollTo = scrollTo;
  try {
    // Another section's place, or one without a position, moves nothing.
    postWindowMessage(frame.contentWindow, { type: "synara:settings-reveal", section: "skills", top: 900 });
    postWindowMessage(frame.contentWindow, { type: "synara:settings-reveal", section: "providers" });
    postWindowMessage(frame.contentWindow, { type: "synara:settings-reveal", section: "providers", top: 900, contentHeight: 2400 });
    await waitFor(() => expect(scrollTo).toHaveBeenCalledTimes(1));
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 884 }));
    expect(frame.style.height).toBe("2400px");
  } finally {
    HTMLElement.prototype.scrollTo = original;
  }

  // The place goes with the request that asked for it, not with later switches:
  // MCP has no such place, and back on Providers nothing asked for it again.
  const nav = (name: string) => fireEvent.click(screen.getByRole("button", { name }));
  nav("MCP");
  await waitFor(() => expect(requests()).toHaveLength(2));
  expect(requests()[1]).toEqual(expect.objectContaining({ section: "integrations" }));
  expect(requests()[1]).not.toHaveProperty("target");
  nav("Providers");
  await waitFor(() => expect(requests()).toHaveLength(3));
  expect(requests()[2]).toEqual(expect.objectContaining({ section: "providers" }));
  expect(requests()[2]).not.toHaveProperty("target");

  // Asking again for the same page, already shown, sends the place again.
  postWindowMessage(agentFrame.contentWindow, { type: "synara:open-settings", section: "providers", target: "provider-binary-paths" });
  await waitFor(() => expect(requests()).toHaveLength(4));
  expect(requests()[3]).toMatchObject({ section: "providers", target: "provider-binary-paths" });
  // A place Lattice does not know opens the page's top.
  postWindowMessage(agentFrame.contentWindow, { type: "synara:open-settings", section: "providers", target: "anything-else" });
  await act(() => nextFrames(2));
  expect(requests()).toHaveLength(4);
});
