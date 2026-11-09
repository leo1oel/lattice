/** What the build pipeline (use-build-pipeline.ts) is given, and what each build request carries. */
import type { Dispatch, SetStateAction } from "react";
import type { BuildResult, ProjectSnapshot } from "../app-types";
import type { CompileDiagnostic } from "../build/compile-diagnostics";
import type { LivePreviewBuildHooks } from "../live-preview/use-live-preview";
import type { BuildPreferences } from "../settings/app-settings";
import type { AgentCompileAssociation } from "./use-agent-checkpoints";

type Ref<T> = { readonly current: T };

export type BuildPipelineInputs = {
  project: ProjectSnapshot | null;
  projectRef: Ref<ProjectSnapshot | null>;
  setProject: Dispatch<SetStateAction<ProjectSnapshot | null>>;
  projectGenerationRef: Ref<number>;
  activeFileRef: Ref<string>;
  sourceRef: Ref<string>;
  savedSourceRef: Ref<string>;
  agent: {
    takePendingCompiles: () => AgentCompileAssociation[];
    reportCompiles: (associations: AgentCompileAssociation[], result: BuildResult | null) => void;
  };
  openDiagnosticRef: Ref<(diagnostic: CompileDiagnostic) => Promise<void>>;
  onMissingTex: () => void;
  /**
   * The LuaLaTeX live preview while it runs: told what each build compiled,
   * so it stops painting edits once the PDF on screen holds them.
   */
  livePreview?: Ref<LivePreviewBuildHooks | null>;
  autoBuildModeRef: Ref<BuildPreferences["autoBuildMode"]>;
};

/** What asked for a build, and how it runs. */
export type BuildOptions = {
  immediatePreview?: boolean;
  requested?: boolean;
  sound?: boolean;
  consumeAgentAssociations?: boolean;
  /** Autosave asked: it waits for a pause while the live preview is live (quiet-builds.ts). */
  automatic?: boolean;
  /** Runs without the Build button's spinner or the PDF's "Updating…" (quiet-builds.ts). */
  quiet?: boolean;
  /** Clean auxiliary files first: Clean and rebuild asked while another build held the pipeline. */
  clean?: boolean;
};
