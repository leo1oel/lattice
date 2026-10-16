/**
 * The build flavor, fixed at build time: `LATTICE_FLAVOR=beta` builds Lattice
 * Beta (docs/release-process.md), the release build sets nothing.
 */
const beta = import.meta.env.LATTICE_FLAVOR === "beta";

/**
 * The browser host's fixed entry port. Beta never takes the release app's, so
 * the two run side by side; PREFERRED_PORT in src-tauri/src/browser_host.rs is
 * the listener this names.
 */
export const BROWSER_ENTRY_PORT = beta ? "18472" : "18452";
