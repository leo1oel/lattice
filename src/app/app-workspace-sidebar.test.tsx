import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { activateAppLocale } from "../i18n";
import type { SynaraPermissionMode } from "./app-synara-embed";
import { AppWorkspaceSidebar, type AppWorkspaceSidebarProps } from "./app-workspace-sidebar";

beforeAll(async () => {
  // Compile the lazy dependency before timing UI queries on busy CI runners.
  await import("../agent/synara-permission-picker");
});

afterEach(async () => {
  cleanup();
  await activateAppLocale("en");
});

function renderSidebar() {
  const onChange = vi.fn();
  // No iframe or navigator is mounted: exercise the real sidebar's agent controls.
  const props = {
    sidebarMode: "agent",
    sidebarModeTier: "full",
    sidebarWidth: 420,
    sidebarOpen: true,
    chooseSidebarMode: vi.fn(),
    synaraOrigin: "http://localhost:9999",
    synaraPermissionMode: "full-access",
    synaraAutoModeAvailable: false,
    synaraFrameReady: true,
    changeSynaraPermissionMode: onChange,
  } as unknown as AppWorkspaceSidebarProps;
  function Sidebar() {
    const [mode, setMode] = useState<SynaraPermissionMode>("full-access");
    return <AppWorkspaceSidebar {...props} synaraPermissionMode={mode} changeSynaraPermissionMode={(value) => {
      onChange(value);
      setMode(value);
    }} />;
  }
  render(<Sidebar />);
  return onChange;
}

it("translates the permission group and updates its open options when the locale changes", async () => {
  await activateAppLocale("zh-CN");
  const onChange = renderSidebar();
  const trigger = await screen.findByRole("button", { name: "智能助手权限：完全访问" });
  expect(trigger).toHaveAttribute("title", "智能助手权限：完全访问");
  fireEvent.click(trigger);
  const fullAccess = await screen.findByRole("radio", { name: "完全访问" });
  expect(fullAccess).toHaveAttribute("aria-checked", "true");
  expect(fullAccess).toHaveAccessibleDescription("无需请求批准即可运行");
  expect(screen.getByRole("radio", { name: "代我批准" })).toHaveAttribute("aria-disabled", "true");
  expect(screen.getByRole("radio", { name: "代我批准" })).toHaveAccessibleDescription("仅对可能不安全的操作请求批准");
  expect(screen.getByRole("radio", { name: "请求批准" })).toHaveAccessibleDescription("在外部修改和网络访问前请求批准");

  await act(() => activateAppLocale("en"));
  expect(trigger).toHaveAttribute("aria-label", "Agent permissions: Full access");
  expect(trigger).toHaveAttribute("title", "Agent permissions: Full access");
  expect(screen.getByRole("radio", { name: "Full access" })).toHaveAccessibleDescription("Run without asking for approval");
  expect(screen.getByRole("radio", { name: "Approve for me" })).toHaveAccessibleDescription("Ask only for potentially unsafe actions");
  const approval = screen.getByRole("radio", { name: "Ask for approval" });
  expect(approval).toHaveAccessibleDescription("Ask before external edits and network access");
  fireEvent.click(approval);
  expect(onChange).toHaveBeenCalledExactlyOnceWith("approval-required");
  expect(approval).toHaveAttribute("aria-checked", "true");
});

it("skips unavailable auto mode with the keyboard and rejects its pointer and keyboard selection", async () => {
  const onChange = renderSidebar();
  fireEvent.click(await screen.findByRole("button", { name: "Agent permissions: Full access" }));
  const fullAccess = await screen.findByRole("radio", { name: "Full access" });
  const auto = screen.getByRole("radio", { name: "Approve for me" });
  expect(fullAccess).toHaveFocus();
  fireEvent.click(auto);
  fireEvent.keyDown(auto, { key: "Enter" });
  fireEvent.keyDown(auto, { key: " " });
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.keyDown(fullAccess, { key: "ArrowDown" });
  const approval = screen.getByRole("radio", { name: "Ask for approval" });
  expect(approval).toHaveFocus();
  expect(approval).toHaveAttribute("aria-checked", "true");
  expect(onChange).toHaveBeenLastCalledWith("approval-required");
  fireEvent.keyDown(approval, { key: "Home" });
  expect(fullAccess).toHaveFocus();
  expect(fullAccess).toHaveAttribute("aria-checked", "true");
});
