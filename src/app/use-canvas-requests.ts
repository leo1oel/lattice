import { useCallback, useState } from "react";
import type { CanvasRequests } from "../app-types";

/** Post, clear or rewrite one pending canvas request (a value or an updater, like a state setter). */
export type UpdateCanvasRequest = <K extends keyof CanvasRequests>(
  kind: K,
  update: CanvasRequests[K] | ((current: CanvasRequests[K]) => CanvasRequests[K]),
) => void;

/**
 * The one-shot requests App hands the canvas (jump to a line, put a view
 * back, insert a citation or figure, rename or wrap an environment). Each
 * kind holds at most one pending request, which the canvas settles by id once
 * it has answered it.
 */
export function useCanvasRequests() {
  const [requests, setRequests] = useState<CanvasRequests>({
    navigation: null, restore: null, rename: null, wrap: null, cite: null, figure: null,
  });
  const update = useCallback<UpdateCanvasRequest>((kind, update) => setRequests((current) => {
    const next = typeof update === "function" ? update(current[kind]) : update;
    return next === current[kind] ? current : { ...current, [kind]: next };
  }), []);
  const settle = useCallback((id: string) => setRequests((current) => {
    const kind = (Object.keys(current) as (keyof CanvasRequests)[]).find((key) => current[key]?.id === id);
    return kind ? { ...current, [kind]: null } : current;
  }), []);
  return { requests, update, settle };
}
