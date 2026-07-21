/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_LATTICE_COLLAB_HOST?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
