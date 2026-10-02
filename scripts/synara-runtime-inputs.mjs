// The repository files that decide what prepare-synara-sidecar.mjs stages,
// besides the pinned Synara source tree itself. The script's build key hashes
// them, and the release workflows' Synara runtime cache keys and the
// release-cache.yml path triggers must cover the same set: a file missing
// there leaves a stale cache that the build key then rejects, so every release
// rebuilds the sidecar from scratch. synara-runtime-inputs.test.ts checks it.
export const SYNARA_RUNTIME_INPUTS = [
  "scripts/synara-runtime.json",
  "scripts/synara-runtime-inputs.mjs",
  "scripts/prepare-synara-sidecar.mjs",
  "scripts/synara-codex-host.mjs",
  "scripts/lib/util.mjs",
  "scripts/lib/codesign.mjs",
];
