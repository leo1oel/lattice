import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  EMPTY_SYNARA_RUNTIME,
  normalizeSynaraOrigin,
  type SynaraRuntimeInfo,
} from "./synara-runtime";

const DEVELOPMENT_ORIGIN = normalizeSynaraOrigin(
  import.meta.env.VITE_SYNARA_EMBED_URL?.trim(),
);

const DEVELOPMENT_RUNTIME: SynaraRuntimeInfo | null = DEVELOPMENT_ORIGIN
  ? { ...EMPTY_SYNARA_RUNTIME, state: "ready", origin: DEVELOPMENT_ORIGIN, startupMs: 0 }
  : null;

function normalizeRuntime(info: SynaraRuntimeInfo): SynaraRuntimeInfo {
  const origin = normalizeSynaraOrigin(info.origin);
  if (info.state !== "ready" || origin) return { ...info, origin };
  return { ...info, state: "stopped", origin, message: "The bundled Agent service did not report a valid local address." };
}

/**
 * Start the bundled service only after a Synara-owned surface is requested.
 * `enabled` is intentionally a one-way App-level latch: once the service has
 * started it may own background turns and terminals, so hiding a surface must
 * not tear it down.
 */
export function useSynaraRuntime(enabled: boolean) {
  const [runtime, setRuntime] = useState<SynaraRuntimeInfo>(
    DEVELOPMENT_RUNTIME ?? EMPTY_SYNARA_RUNTIME,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (DEVELOPMENT_RUNTIME || !enabled) return;
    let disposed = false;
    void invoke<SynaraRuntimeInfo>("synara_ensure_ready")
      .then((info) => {
        if (!disposed) setRuntime(normalizeRuntime(info));
      })
      .catch((reason) => {
        if (disposed) return;
        setRuntime({
          ...EMPTY_SYNARA_RUNTIME,
          state: "stopped",
          message: reason instanceof Error ? reason.message : String(reason),
        });
      });
    return () => {
      disposed = true;
    };
  }, [attempt, enabled]);

  const retry = useCallback(() => {
    setRuntime((current) => ({ ...current, state: "starting", message: null }));
    setAttempt((value) => value + 1);
  }, []);
  return { runtime, retry };
}
