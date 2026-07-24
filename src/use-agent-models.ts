/**
 * The model list, taken from the agent runtime rather than written down here.
 *
 * The runtime is where model support actually lives, and it ships far more
 * often than this app does — a list hard-coded here is stale the week a model
 * comes out. Asking it means new models appear as soon as the runtime knows
 * about them, with the thinking levels that model really supports.
 *
 * The built-in table stays as the fallback, and it matters: the runtime only
 * answers for providers that are signed in, so before anyone connects an
 * account there is nothing to ask.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentModel, AgentProvider, ModelOption, ReasoningEffort } from "./app-types";
import { modelOptions } from "./app-utils";

const EFFORTS: ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh", "max", "ultra"];

function isEffort(value: string): value is ReasoningEffort {
  return (EFFORTS as string[]).includes(value);
}

/** Runtime models in the shape the pickers already use. */
function toOptions(models: AgentModel[]): ModelOption[] {
  return models
    .map((model) => ({
      value: model.value,
      label: model.label,
      // Keep our own order rather than the runtime's, so the effort menu reads
      // the same for every model.
      efforts: EFFORTS.filter((effort) => model.efforts.some(
        (value) => isEffort(value) && value === effort,
      )),
    }))
    // A model with no thinking levels at all cannot be driven by this app's
    // effort control, so leave it out rather than showing an empty menu.
    .filter((option) => option.efforts.length > 0);
}

export type AgentModelCatalog = {
  /** Options for a provider: the runtime's when we have them, ours otherwise. */
  options: (provider: AgentProvider) => ModelOption[];
  /** Re-ask the runtime — after signing in to an account, say. */
  refresh: () => void;
};

export function useAgentModels(): AgentModelCatalog {
  const [catalog, setCatalog] = useState<Partial<Record<AgentProvider, ModelOption[]>>>({});
  const asked = useRef<Set<AgentProvider>>(new Set());

  const load = useCallback((provider: AgentProvider) => {
    void invoke<AgentModel[]>("agent_models", { provider })
      .then((models) => {
        const options = toOptions(models);
        // An empty answer means "not signed in", not "no models exist".
        if (options.length) setCatalog((current) => ({ ...current, [provider]: options }));
      })
      .catch(() => {
        // The built-in list is the answer when the runtime cannot be asked.
      });
  }, []);

  const refresh = useCallback(() => {
    asked.current = new Set();
    setCatalog({});
  }, []);

  const options = useCallback((provider: AgentProvider) => {
    if (!asked.current.has(provider)) {
      asked.current.add(provider);
      load(provider);
    }
    return catalog[provider] ?? modelOptions(provider);
  }, [catalog, load]);

  // Ask for everything once on startup so the first open of the picker is
  // already current, rather than filling in under the pointer.
  useEffect(() => {
    for (const provider of ["codex", "claude", "openai-api", "anthropic-api"] as AgentProvider[]) {
      if (asked.current.has(provider)) continue;
      asked.current.add(provider);
      load(provider);
    }
  }, [load]);

  return { options, refresh };
}
