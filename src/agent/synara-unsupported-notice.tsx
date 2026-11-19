import { ShieldOff } from "lucide-react";
import { useLingui } from "@lingui/react/macro";
import type { SynaraRuntimeInfo } from "./synara-runtime";
import { isWindowsHost } from "../platform/host-platform";
import { hostErrorText } from "../platform/host-error-text";

/**
 * The Agent where Lattice cannot stop it from editing .bib files itself: it
 * stays off and says why. There is nothing to retry or diagnose, so no
 * Retry, logs or Details. Windows has no guard at all. Linux has one that
 * needs bubblewrap, FUSE and a kernel that scopes abstract sockets, and does
 * not reach every folder, so there the runtime's message names what is
 * missing, and the setting that runs the Agent without the last
 * (synara/bibliography_guard/linux.rs).
 * scripts/linux-e2e.mjs finds it by its `synara-unsupported-notice` class.
 */
export function SynaraUnsupportedNotice({ runtime }: { runtime: SynaraRuntimeInfo }) {
  const { t } = useLingui();
  const windows = isWindowsHost();
  const reason = runtime.message?.trim();
  return (
    <div className="synara-loading-surface synara-unsupported-notice" role="status">
      <span className="synara-loading-mark" aria-hidden="true">
        <ShieldOff size={17} />
      </span>
      <div className="synara-loading-copy">
        <strong>{windows ? t`Agent isn’t available on Windows yet` : t`Agent isn’t available here`}</strong>
        <p>{windows
          ? t`This Windows build cannot yet protect .bib files from direct agent edits. Use Claude Code or Codex in the Terminal panel. Features that require the built-in agent are unavailable.`
          : reason
            ? hostErrorText(reason)
            : t`Lattice cannot keep the Agent from editing .bib files directly here, so it stays off instead of running without that protection.`}</p>
      </div>
    </div>
  );
}
