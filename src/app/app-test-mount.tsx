/**
 * Mounts the App assembly for an integration suite: App with the real surfaces the suite's feature needs
 * (`app-test-canvas.ts`, `app-test-pdf-panel.ts`, `app-test-settings.ts`) and inert doubles for the rest, so
 * a change inside one surface reruns only the suites that mount it. App still owns every shared state hook,
 * so a change to App or to one of those reruns every suite. Cross-surface behavior belongs in
 * `app-composition.test.tsx`, which mounts the production surfaces.
 */
import { invoke } from "@tauri-apps/api/core";
import { render } from "@testing-library/react";
import { beforeAll, expect, vi } from "vitest";
import {
  buildResult, expectInvoked, mockCommands, overleafCommands, overleafPaperSnapshot, projectCommands, projectSnapshot,
  refreshableProject, ROOT, setAutoBuildMode, type Commands,
} from "./app-test-utils";
import App from "../App";
import type { AppSurfaces } from "./app-surfaces";
import type { ProjectSnapshot } from "../app-types";
import { ConfirmActionProvider } from "../components/ui/confirm-action-dialog";
import { chunk } from "../lib/lazy-chunk";
import { loadPaperLibrary, loadProjectFileTree, loadTrellisWorkspace } from "./workspace-chunks";
// Keep the cold Vite transforms of these real lazy parts of App outside interaction-test deadlines; the tests
// still mount them, not doubles: the Trellis workspace every open project renders into, the file tree and paper
// library, the Agent panel, and the Overleaf and comment surfaces the comment-routing regressions use.
import "../trellis/trellis-workspace";
import "../trellis/trellis-agent-surface";
import "../project/project-file-tree";
import "../project/paper-library";
import "../overleaf/overleaf-collab";
import "../editor/comments/editor-comments-panel";

// Their chunks too: a chunk resolves only once something asks for it, so a file's first test opened its project
// with the workspace's chunks still on their way, and every later test with them in. A test that acts as soon
// as the project shows (opening the Git drawer, in app-agent) passed only after another test in its file.
beforeAll(async () => {
  await Promise.all([loadTrellisWorkspace(), loadProjectFileTree(), loadPaperLibrary()]);
});

/** A chunk that is in at once: a double's gate opens on the first render. */
const present = chunk(async () => ({}));

/** Surfaces that render nothing, standing in for the ones a suite does not test. */
const SURFACE_DOUBLES: AppSurfaces = {
  documentCanvas: { load: present, Component: () => null },
  projectPdfPanel: { load: present, Component: () => null },
  settingsDialog: () => null,
};

/** The render helpers of a suite whose App mounts `surfaces`, and doubles for the surfaces it leaves out. */
export function appHarness(surfaces: Partial<AppSurfaces> = {}) {
  const mounted: AppSurfaces = { ...SURFACE_DOUBLES, ...surfaces };

  /** Renders the app, first answering `invoke` from `commands` when given; `confirmations` mounts the in-app
   * confirmation dialog host `main.tsx` provides. */
  function renderApp(commands?: Commands, { confirmations = false } = {}) {
    if (commands) mockCommands(commands);
    const app = <App surfaces={mounted} />;
    return render(confirmations ? <ConfirmActionProvider>{app}</ConfirmActionProvider> : app);
  }

  /** Renders a linked Overleaf project — the Overleaf paper unless `snapshot` says otherwise — with manual builds
   * and, when given, a persisted Overleaf sync mode. */
  function renderOverleafPaper(overrides: Commands, { snapshot = overleafPaperSnapshot(), syncMode, confirmations }:
    { snapshot?: ProjectSnapshot; syncMode?: "live" | "manual"; confirmations?: boolean } = {}) {
    setAutoBuildMode("manual");
    if (syncMode) localStorage.setItem("lattice.overleaf.sync-mode.v1", syncMode);
    return renderApp({ ...refreshableProject(snapshot), ...overleafCommands(overrides) }, { confirmations });
  }

  /** Opens `snapshot` with automatic builds, waits for its initial build, then forgets the calls made so far. */
  async function openWithAutomaticBuilds(commands: Commands, snapshot = projectSnapshot({ files: [] })) {
    setAutoBuildMode("automatic");
    renderApp({ ...projectCommands(snapshot), build_project: buildResult(), ...commands });
    await expectInvoked("build_project", expect.objectContaining({ force: false, projectRoot: ROOT }));
    vi.mocked(invoke).mockClear();
  }

  return { renderApp, renderOverleafPaper, openWithAutomaticBuilds };
}
