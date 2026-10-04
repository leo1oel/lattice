/// <reference types="vite/client" />

/** The embedded fonts' LICENSE.pdf, as an app asset URL (scripts/private-fonts.ts); null without them. */
declare module "virtual:lattice-private-fonts-license" {
  export const fontLicenseUrl: string | null;
}

declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}

interface ImportMetaEnv {
  readonly VITE_SYNARA_EMBED_URL?: string;
  /** "1" only in perf-lab builds (scripts/perf-lab.mjs). */
  readonly VITE_PERF_LAB?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

interface Window {
  /** Set by the perf-lab harness while it drives a measurement run. */
  __latticeLab?: boolean;
  __LATTICE_BROWSER_HOST_CONFIG__?: {
    token: string;
    port: number;
  };
}
