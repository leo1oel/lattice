import { createRef, useCallback, useEffect, useLayoutEffect, useRef, useReducer, type RefObject } from "react";
import { msg } from "@lingui/core/macro";
import { i18n } from "../i18n";
import { invoke } from "@tauri-apps/api/core";
import { useLatestRef } from "../hooks/use-latest-ref";
import { forgetProjectAgent, projectAgentInFlight } from "../agent/project-agent-activity";
import type { AgentComposerPromptMessage } from "../agent/agent-composer-prompt";
import type { AgentHostContextSnapshot } from "../agent/agent-host-context";
import type { AgentPaperLibrarySnapshot } from "../agent/agent-paper-library";
import type { AgentDeckPresence } from "../agent/agent-turn-activity";
import type { parseAgentProjectHistorySnapshot } from "../agent/synara-runtime";
import { windowProjects } from "./window-projects";

type ProjectHistory = NonNullable<ReturnType<typeof parseAgentProjectHistorySnapshot>>;

export type SynaraProjectFrame = {
  root: string;
  ref: RefObject<HTMLIFrameElement | null>;
  attempt: number;
  load: number;
  ready: boolean;
};

type ProjectFrameContext = {
  hostContext: AgentHostContextSnapshot | null;
  paperLibrary: AgentPaperLibrarySnapshot | null;
  history: ProjectHistory | null;
  deckPresence: AgentDeckPresence | null;
  permissionMode: { mode: unknown; autoModeAvailable: boolean } | null;
  minimumWidth: number | null;
  pendingPrompt: AgentComposerPromptMessage | null;
};

/** Leave time for a just-sent prompt to produce activity, and for a finished turn's toast to be opened. */
const IDLE_FRAME_DELAY = 30_000;

function updateProjectFrames(
  current: readonly SynaraProjectFrame[], update: (current: readonly SynaraProjectFrame[]) => readonly SynaraProjectFrame[],
) {
  return update(current);
}

export function useSynaraProjectFrames(projectRoot: string | null, serviceIdentity: string | null) {
  const [frames, setFrames] = useReducer(updateProjectFrames, []);
  const framesRef = useLatestRef(frames);
  const rootRef = useLatestRef(projectRoot);
  const contexts = useRef(new Map<string, ProjectFrameContext>());
  const timers = useRef(new Map<string, number>());
  const leases = useRef(new Set<string>());
  const knownTabs = useRef(new Set<string>());
  const lastService = useRef(serviceIdentity);
  const ownedRoots = useRef(new Set<string>());
  const currentFrame = frames.find((frame) => frame.root === projectRoot);

  const contextFor = useCallback((root: string) => {
    const existing = contexts.current.get(root);
    if (existing) return existing;
    const context: ProjectFrameContext = {
      hostContext: null, paperLibrary: null, history: null, deckPresence: null,
      permissionMode: null, minimumWidth: null, pendingPrompt: null,
    };
    contexts.current.set(root, context);
    ownedRoots.current.add(root);
    return context;
  }, []);
  const mountProjectFrame = useCallback((root: string) => {
    setFrames((current) => current.some((frame) => frame.root === root)
      ? current : [...current, { root, ref: createRef(), attempt: 0, load: 0, ready: false }]);
  }, []);
  const updateFrame = useCallback((root: string, update: (frame: SynaraProjectFrame) => SynaraProjectFrame) => {
    setFrames((current) => {
      const frame = current.find((entry) => entry.root === root);
      if (!frame) return current;
      const next = update(frame);
      return next === frame ? current : current.map((entry) => entry === frame ? next : entry);
    });
  }, []);
  const frameLoading = useCallback((root: string) => {
    updateFrame(root, (frame) => ({ ...frame, load: frame.load + 1, ready: false }));
  }, [updateFrame]);
  const frameBecameReady = useCallback((frame: SynaraProjectFrame) => {
    updateFrame(frame.root, (current) => current.load !== frame.load || current.ready
      ? current : { ...current, ready: true });
  }, [updateFrame]);
  const retryProjectFrame = useCallback((root: string) => {
    updateFrame(root, (frame) => ({ ...frame, attempt: frame.attempt + 1, load: frame.load + 1, ready: false }));
  }, [updateFrame]);

  const releaseLease = useCallback((root: string) => {
    if (leases.current.delete(root)) {
      void invoke("release_background_agent_project", { projectRoot: root }).catch(() => undefined);
    }
  }, []);
  const retainBackgroundProject = useCallback(async (root: string) => {
    // Activity and a pending prompt travel in separate events. Retain even an
    // apparently idle mounted pair while the outgoing root is still bound.
    if (leases.current.has(root) || !framesRef.current.some((frame) => frame.root === root && frame.ref.current)) return;
    const retained = await invoke<boolean>("retain_background_agent_project", { projectRoot: root });
    if (retained === false) throw new Error(i18n._(msg`Could not keep this project's Agent connected while switching tabs.`));
    leases.current.add(root);
  }, [framesRef]);
  const clearTimer = useCallback((root: string) => {
    const timer = timers.current.get(root);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(root);
  }, []);
  const retireFrame = useCallback((root: string) => {
    clearTimer(root);
    contexts.current.delete(root);
    releaseLease(root);
    setFrames((current) => current.filter((frame) => frame.root !== root));
  }, [clearTimer, releaseLease]);
  const scheduleRetirement = useCallback((root: string) => {
    const inFlight = () => projectAgentInFlight(root, Boolean(contexts.current.get(root)?.deckPresence));
    if (rootRef.current === root || inFlight()) {
      clearTimer(root);
      return;
    }
    if (timers.current.has(root)) return;
    timers.current.set(root, window.setTimeout(() => {
      timers.current.delete(root);
      if (rootRef.current !== root && !inFlight()) retireFrame(root);
    }, IDLE_FRAME_DELAY));
  }, [clearTimer, retireFrame, rootRef]);

  useEffect(() => {
    const pruneClosedTabs = () => {
      const tabs = new Set(windowProjects.get().map((project) => project.root));
      for (const root of tabs) knownTabs.current.add(root);
      for (const root of knownTabs.current) {
        if (tabs.has(root) || rootRef.current === root) continue;
        forgetProjectAgent(root);
        ownedRoots.current.delete(root);
        knownTabs.current.delete(root);
        retireFrame(root);
      }
    };
    pruneClosedTabs();
    return windowProjects.subscribe(pruneClosedTabs);
  }, [projectRoot, retireFrame, rootRef]);
  useEffect(() => {
    for (const frame of frames) scheduleRetirement(frame.root);
  }, [frames, projectRoot, scheduleRetirement]);
  useEffect(() => {
    if (projectRoot) releaseLease(projectRoot);
  }, [projectRoot, releaseLease]);

  useLayoutEffect(() => {
    const retired = lastService.current !== null && serviceIdentity !== lastService.current;
    lastService.current = serviceIdentity;
    if (!retired) return;
    for (const root of ownedRoots.current) forgetProjectAgent(root);
    for (const frame of framesRef.current) {
      const context = contexts.current.get(frame.root);
      if (context) context.deckPresence = null;
      if (frame.root !== rootRef.current) retireFrame(frame.root);
    }
  }, [framesRef, retireFrame, rootRef, serviceIdentity]);

  useEffect(() => {
    const ownedTimers = timers.current;
    const ownedLeases = leases.current;
    const roots = ownedRoots.current;
    return () => {
      for (const timer of ownedTimers.values()) window.clearTimeout(timer);
      ownedTimers.clear();
      for (const root of ownedLeases) releaseLease(root);
      for (const root of roots) forgetProjectAgent(root);
      roots.clear();
    };
  }, [releaseLease]);

  return {
    frames, framesRef, currentFrame, contextFor, mountProjectFrame, frameLoading,
    frameBecameReady, retryProjectFrame, scheduleRetirement, retainBackgroundProject,
  };
}
