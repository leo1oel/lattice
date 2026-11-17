import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { isRecord } from "../app-utils";

type ProjectActivity = {
  running: boolean;
  waiting: boolean;
  completedUnread: boolean;
};

type ProjectAgentStatus = "running" | "waiting" | "completed";
const projects = new Map<string, ProjectActivity>();
const listeners = new Set<() => void>();
let visibleTurnRunning = false;
let reportedRunning = false;

function reportRunning() {
  const running = visibleTurnRunning || [...projects.values()].some(({ running, waiting }) => running || waiting);
  if (running === reportedRunning) return;
  reportedRunning = running;
  void invoke("set_agent_turn_running", { running }).catch(() => undefined);
}

/** The deck's older focused-thread report still protects app restarts before
 * an authoritative project snapshot arrives. */
export function setVisibleAgentTurnRunning(running: boolean) {
  visibleTurnRunning = running;
  reportRunning();
}

function publish() {
  reportRunning();
  for (const listener of listeners) listener();
}

/** The caller has already verified the sending frame and its origin. Check
 * the reported root again so stale messages cannot update another tab. */
export function receiveProjectAgentActivity(root: string, message: unknown) {
  if (!isRecord(message) || message.type !== "synara:project-agent-activity") return;
  const { version, workspaceRoot, running, waiting, completedUnread } = message;
  if (version !== 1 || workspaceRoot !== root
    || typeof running !== "boolean" || typeof waiting !== "boolean" || typeof completedUnread !== "boolean") return;
  const previous = projects.get(root);
  if (previous?.running === running && previous.waiting === waiting && previous.completedUnread === completedUnread) return;
  projects.set(root, { running, waiting, completedUnread });
  publish();
}

export function projectAgentInFlight(root: string, fallback = false): boolean {
  const activity = projects.get(root);
  return activity ? activity.running || activity.waiting : fallback;
}

export function forgetProjectAgent(root: string) {
  if (projects.delete(root)) publish();
}

function projectAgentStatus(root: string): ProjectAgentStatus | null {
  const activity = projects.get(root);
  if (activity?.waiting) return "waiting";
  if (activity?.running) return "running";
  return activity?.completedUnread ? "completed" : null;
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useProjectAgentStatus(root: string) {
  return useSyncExternalStore(subscribe, () => projectAgentStatus(root));
}
