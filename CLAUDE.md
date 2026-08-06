# CLAUDE.md

Lattice — a local-first LaTeX writing app for macOS. Tauri 2 (Rust) shell +
React 19 / TypeScript / Vite 7 frontend, with a bundled AI-agent sidecar
(Synara) and CRDT collaboration (Yjs + Cloudflare Workers).

## Commands

```bash
pnpm tauri dev                  # run the desktop app (needs ../synara-poc checkout, see README)
pnpm check                      # THE gate: lint + vitest + web build + cargo test + clippy -D warnings
pnpm vitest run <file>          # one test file
cargo fmt --manifest-path src-tauri/Cargo.toml --all   # CI checks fmt; pnpm check does NOT — run it before pushing
node scripts/bump-version.mjs patch   # release: bump, commit, tag vX.Y.Z, push tag → CI publishes
```

Lint enforces `--max-warnings 139` as a debt cap: lower it when you remove
warnings; never raise it.

## Layout

- `src/` — frontend. `App.tsx` is the hub (state, IPC, wiring); `document-canvas.tsx` hosts the editors; most panels are `React.lazy`.
- `src/open-knowledge-app/` — **vendored** from an upstream repo by `scripts/vendor-open-knowledge.mjs` (see its MANIFEST). Local patches are accepted practice but re-vendoring can overwrite them; prefer changes outside when possible. `src/open-knowledge-core/` is related but NOT auto-synced.
- `src-tauri/src/` — Rust: project validation/transactions (`project.rs`), LaTeX build (`latex.rs`), Overleaf sync (`overleaf*.rs`), papers/OpenAlex, TexLab, FTS, the Synara supervisor (`synara.rs`).
- `collab-server/` — Cloudflare Worker (Durable Objects) for Lattice Shares; own package.json; deploy with `pnpm collab:deploy`.
- `protocol/` — types shared between frontend and collab-server.
- `src-tauri/synara-runtime/` — staged agent runtime (gitignored); produced by `scripts/prepare-synara-sidecar.mjs` from the pinned source in `scripts/synara-runtime.json`.

## Collaboration v2 model

Every file is its own Y.Doc namespace `{projectInstanceId, fileId, documentEpoch}`.
The controller (`src/collab-project-v2.ts`) owns a client pool (capacity 8, LRU
eviction of unpinned clean clients; pin names: `main`, `secondary`, `chat`).

- Only the primary editor binding may *activate* a doc (`openPath(path, "main")`).
  Everything else — secondary pane, saves, observers, chat, comments — must pass
  `{ sideload: true }` or it steals `activePath` and silently unbinds the
  primary editor's yCollab.
- Project-wide chat and editor comments ride dedicated catalog files
  (`.research/collab-chat.json`, `.research/editor-comments.json`) — data lives
  on Y types beside the empty `"content"` text. The server validates every
  fileId against the catalog; synthetic namespaces do not work.
- Read-grant peers cannot write any doc (server closes 4403 and permanently
  stops that client) — gate write paths in the UI.

## Bundle-size and startup constraints (deliberate, please preserve)

- **Never value-import `tldraw` from eagerly-loaded modules.** Its barrel has no
  `sideEffects` flag; one import drags ~1.5 MB + prosemirror into the startup
  chunk. The agent-canvas tldraw adapter lives in
  `src/agent-canvas-tldraw-adapter.ts` behind the lazy board editor.
- `vite.config.ts` has `shikiTrimPlugin`: all shiki grammars/themes outside a
  runtime-reachable allowlist are stubbed. If new code can highlight more
  languages at runtime, extend the allowlist there.
- The eager startup graph is three chunks (`app`, `ui`, `provided-icons`,
  ~1.2 MB total). Check `dist/index.html` after touching imports near App.tsx;
  heavy libs (pdfjs, mermaid, katex, harper, codemirror langs, tiptap) must
  stay behind dynamic imports.
- `src-tauri/Cargo.toml` has a size-tuned `[profile.release]`; `panic = "abort"`
  is intentionally off (a panic must not kill the app with unsaved edits).
- `scripts/prepare-synara-sidecar.mjs` prunes the sidecar aggressively. If the
  runtime gains new imports, check the unreachable-packages list there;
  top-level `ajv`, `ajv-formats`, `zod` must stay (undeclared runtime requires
  of the agent SDKs).

## Design-system contract (enforced by tests)

`src/styles/tokens.test.ts` fails the build when:
- spacing uses a raw px value that is on the scale — use `var(--space-*)` from `foundations.css`;
- palette tokens (`--bg`, `--text`, …) are referenced outside theme/foundations;
- a referenced custom property resolves nowhere.

`docs/design-system.md` records the typography/density decisions.

## Testing notes

- Vitest + jsdom + fake-indexeddb; collab tests stub `fetch` against a mock
  coordinator (see `setupCreateTest` in `src/collab-project-v2.test.ts` — reuse
  it for controller tests).
- `App.test.tsx` renders the real App with mocked `invoke`; startup ordering
  matters (the backend's `initial_project` must beat the recent-project
  auto-reopen — see `initialProjectProbe` in App.tsx).
- CI runners are slow: avoid tests that depend on nothing re-rendering between
  two events; async highlight/render passes can land in between.

## Conventions

- Comments explain constraints the code can't show; match the existing
  comment-heavy style of tricky modules (collab, App.tsx effects).
- Follow existing patterns for Tauri `listen()` cleanup (disposed-flag +
  unlisten race) and generation guards on async loads.
- Version is bumped in lockstep across package.json / tauri.conf.json /
  Cargo.toml by `scripts/bump-version.mjs` only.
