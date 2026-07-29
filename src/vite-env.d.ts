/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LATTICE_COLLAB_HOST?: string;
  readonly VITE_SYNARA_EMBED_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
