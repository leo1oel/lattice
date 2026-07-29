import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  EMPTY_SYNARA_RUNTIME,
  normalizeSynaraOrigin,
  type SynaraRuntimeInfo,
} from "./synara-runtime";

const DEVELOPMENT_ORIGIN = normalizeSynaraOrigin(
  import.meta.env.VITE_SYNARA_EMBED_URL?.trim(),
);
const TAURI_RUNTIME_AVAILABLE =
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
export const SYNARA_RUNTIME_ENABLED = Boolean(DEVELOPMENT_ORIGIN) || TAURI_RUNTIME_AVAILABLE;

function developmentRuntime(): SynaraRuntimeInfo | null {
  if (!DEVELOPMENT_ORIGIN) return null;
  return {
    state: "ready",
    origin: DEVELOPMENT_ORIGIN,
    authToken: null,
    message: null,
    startupMs: 0,
    version: null,
    revision: null,
  };
}

const DEVELOPMENT_RUNTIME = developmentRuntime();

function normalizeRuntime(info: SynaraRuntimeInfo): SynaraRuntimeInfo {
  const origin = normalizeSynaraOrigin(info.origin);
  return {
    ...info,
    state: info.state === "ready" && !origin ? "stopped" : info.state,
    origin,
    message:
      info.state === "ready" && !origin
        ? "The bundled Agent service did not report a valid local address."
        : info.message,
  };
}

export function useSynaraRuntime() {
  const [runtime, setRuntime] = useState<SynaraRuntimeInfo>(
    DEVELOPMENT_RUNTIME ?? EMPTY_SYNARA_RUNTIME,
  );
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!SYNARA_RUNTIME_ENABLED) return;
    if (DEVELOPMENT_RUNTIME) return;
    let disposed = false;
    const stopListening = listen<SynaraRuntimeInfo>(
      "synara-runtime://status",
      ({ payload }) => {
        if (!disposed) setRuntime(normalizeRuntime(payload));
      },
    );
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
      void stopListening.then((unlisten) => unlisten());
    };
  }, [attempt]);

  const retry = useCallback(() => {
    setRuntime((current) => ({ ...current, state: "starting", message: null }));
    setAttempt((value) => value + 1);
  }, []);
  return { enabled: SYNARA_RUNTIME_ENABLED, runtime, retry };
}
