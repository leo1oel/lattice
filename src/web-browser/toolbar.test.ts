import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import { mountBrowserToolbar } from "./toolbar";

let cleanup: () => void;
afterEach(() => { cleanup?.(); document.body.replaceChildren(); vi.useRealTimers(); });
it("shows native page metadata, sends navigation actions, and preserves an address being edited", async () => {
  vi.useFakeTimers();
  const root = document.createElement("div");
  document.body.append(root);
  const invoke = vi.fn().mockResolvedValue({ url: "https://example.org/one", title: "First page", loading: false });
  cleanup = mountBrowserToolbar(root, { invoke }, "en");
  await vi.advanceTimersByTimeAsync(0);
  const address = within(root).getByRole("textbox", { name: "Web address" });
  expect(address).toHaveValue("https://example.org/one");
  expect(within(root).getByRole("status")).toHaveTextContent("First page");
  address.focus();
  fireEvent.input(address, { target: { value: "https://example.org/two" } });
  await vi.advanceTimersByTimeAsync(600);
  expect(address).toHaveValue("https://example.org/two");
  fireEvent.submit(root.querySelector("form")!);
  expect(invoke).toHaveBeenCalledWith("web_browser_navigate", { url: "https://example.org/two" });
  for (const [label, action] of [["Back", "back"], ["Forward", "forward"], ["Reload", "reload"], ["Open in default browser", "external"], ["Close browser", "close"]]) {
    fireEvent.click(within(root).getByRole("button", { name: label }));
    expect(invoke).toHaveBeenCalledWith("web_browser_action", { action });
  }
  cleanup();
  invoke.mockClear();
  await vi.advanceTimersByTimeAsync(1200);
  expect(invoke).not.toHaveBeenCalled();
});

it("localizes the independent toolbar and does not render a raw backend error", async () => {
  vi.useFakeTimers();
  const root = document.createElement("div"); document.body.append(root);
  const invoke = vi.fn().mockRejectedValue(new Error("private transport detail"));
  cleanup = mountBrowserToolbar(root, { invoke }, "zh-CN");
  await vi.advanceTimersByTimeAsync(0);
  expect(within(root).getByRole("button", { name: "后退" })).toBeInTheDocument();
  expect(within(root).getByRole("status")).toHaveTextContent("浏览器操作失败");
  expect(root.textContent).not.toContain("private transport detail");
});
