/// <reference types="vite/client" />

declare module "*.po" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}

interface ImportMetaEnv {
  readonly VITE_LATTICE_COLLAB_HOST?: string;
  readonly VITE_SYNARA_EMBED_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
