import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import {
  forgetProjectAgent,
  projectAgentInFlight,
  receiveProjectAgentActivity,
  setVisibleAgentTurnRunning,
  useProjectAgentStatus,
} from "./project-agent-activity";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(async () => undefined) }));

const left = "/projects/a";
const right = "/projects/b";

function report(root: string, activity: Partial<Record<"running" | "waiting" | "completedUnread", boolean>>) {
  receiveProjectAgentActivity(root, {
    type: "synara:project-agent-activity",
    version: 1,
    workspaceRoot: root,
    running: false,
    waiting: false,
    completedUnread: false,
    ...activity,
  });
}

afterEach(() => {
  forgetProjectAgent(left);
  forgetProjectAgent(right);
  setVisibleAgentTurnRunning(false);
  vi.clearAllMocks();
});

it("keeps each project's running, waiting, and unread state and guards restarts while any project works", () => {
  const { result } = renderHook(() => [useProjectAgentStatus(left), useProjectAgentStatus(right)]);
  act(() => {
    report(left, { running: true });
    report(right, { running: true });
    setVisibleAgentTurnRunning(false);
  });
  expect(result.current).toEqual(["running", "running"]);
  expect(invoke).toHaveBeenCalledExactlyOnceWith("set_agent_turn_running", { running: true });
  act(() => {
    report(left, { waiting: true, running: true, completedUnread: true });
    report(right, { completedUnread: true });
  });
  expect(result.current).toEqual(["waiting", "completed"]);
  expect(projectAgentInFlight(left)).toBe(true);
  expect(projectAgentInFlight(right)).toBe(false);
  expect(invoke).toHaveBeenCalledTimes(1);
  act(() => {
    report(left, { completedUnread: true });
    report(right, {});
  });
  expect(result.current).toEqual(["completed", null]);
  expect(invoke).toHaveBeenLastCalledWith("set_agent_turn_running", { running: false });
});

it("ignores malformed and misrouted reports", () => {
  const { result } = renderHook(() => useProjectAgentStatus(left));
  const message = { type: "synara:project-agent-activity", version: 1, running: true, waiting: false, completedUnread: false };
  act(() => {
    receiveProjectAgentActivity(left, { ...message, workspaceRoot: right });
    receiveProjectAgentActivity(left, { ...message, workspaceRoot: left, waiting: "true" });
  });
  expect(result.current).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});
