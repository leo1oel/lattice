# Pinned production stylesheet preloader fixture

`helper.mjs` is the **unmodified** generated Vite preloader from the prepared
Synara 1.1.0 artifact at the repository's pinned revision. `metadata.json` records
its original filename, source revision, Vite version (the Synara bun.lock pin),
SHA-256 and generator source. It is test-only and is never served by Lattice.

The helper is Vite core code under MIT. `LICENSE.txt` reproduces the core license
from the official `vite@8.1.5` npm distribution. Do not reformat this fixture: the
consumer verifies its SHA. When upgrading Synara, replace the fixture from the
new prepared pinned artifact, review the changed preloader behavior, update the
metadata/license if needed, and rerun the browser resource test.
