/** Persist the project a guest left when joining a share, so Leave can restore it. */

const PRE_COLLAB_ROOT_KEY = "lattice.preCollabProjectRoot.v1";

export function isLatticeSharesPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/");
  return normalized.includes("/Lattice Shares/")
    || normalized.endsWith("/Lattice Shares")
    || /\/Lattice Shares$/i.test(normalized);
}

export function rememberPreCollabProjectRoot(root: string | null | undefined): void {
  const trimmed = root?.trim() ?? "";
  if (!trimmed || isLatticeSharesPath(trimmed)) {
    clearPreCollabProjectRoot();
    return;
  }
  try {
    sessionStorage.setItem(PRE_COLLAB_ROOT_KEY, trimmed);
  } catch {
    // sessionStorage may be unavailable; in-memory ref still works for this session.
  }
}

export function loadPreCollabProjectRoot(): string | null {
  try {
    const stored = sessionStorage.getItem(PRE_COLLAB_ROOT_KEY)?.trim() ?? "";
    if (stored && !isLatticeSharesPath(stored)) return stored;
  } catch {
    // Ignore.
  }
  return null;
}

export function clearPreCollabProjectRoot(): void {
  try {
    sessionStorage.removeItem(PRE_COLLAB_ROOT_KEY);
  } catch {
    // Ignore.
  }
}

/** Prefer the remembered root; otherwise the most recent non-share project. */
export function resolvePreCollabProjectRoot(
  remembered: string | null | undefined,
  recentPaths: string[],
): string | null {
  const primary = remembered?.trim() || loadPreCollabProjectRoot();
  if (primary && !isLatticeSharesPath(primary)) return primary;
  for (const path of recentPaths) {
    const trimmed = path.trim();
    if (trimmed && !isLatticeSharesPath(trimmed)) return trimmed;
  }
  return null;
}
