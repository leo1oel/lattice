# CLAUDE.md

Lattice — a local-first LaTeX writing app for macOS. Tauri 2 (Rust) shell +
React 19 / TypeScript / Vite 8 frontend, with a bundled AI-agent sidecar
(Synara) and CRDT collaboration (Yjs + Cloudflare Workers).

## Commands

```bash
pnpm tauri dev                  # run the desktop app (needs the pinned Synara checkout, see below)
pnpm check                      # THE gate: i18n + lint + vitest + web build + collab-server + rustfmt + cargo test + clippy
pnpm vitest run <file>          # one test file
node scripts/bump-version.mjs patch   # release: rewrites the version in package.json,
                                      # tauri.conf.json, Cargo.toml and Cargo.lock, then PRINTS
                                      # the add/commit/tag/push commands. It runs none of them —
                                      # pushing the tag yourself is what triggers CI to publish.
```

Only `pnpm tauri dev` / `pnpm tauri build` need the Synara source.
Everything else — including `pnpm check`, `cargo test`, and `cargo clippy` — only needs resource stubs for the bundled runtimes:

```bash
mkdir -p src-tauri/{synara-runtime,chromium-runtime}
touch src-tauri/{synara-runtime,chromium-runtime}/placeholder.txt
```

For the real sidecar, clone `repository` from `scripts/synara-runtime.json` at
its pinned `revision` and point `SYNARA_SOURCE_DIR` at it (the default,
`sourceDirectory` in that same file, is `../synara-v081-sync` today and moves
with the pinned branch — derive it, don't hardcode it). See CONTRIBUTING.md and
`scripts/setup-dev.sh`.

`pnpm check` is `mise run check`: eight stages (`i18n-check`, `lint`, `test`,
`build`, `collab-server`, `cargo-fmt`, `cargo-test`, `clippy`) in parallel,
skipping any whose declared `sources` have not changed. Needs
[mise](https://mise.jdx.dev). It runs the *same commands* as
`.github/workflows/ci.yml`, not the same way: CI is a clean checkout with
nothing skipped, on Node 22, Rust on macOS and everything else on Ubuntu, while
mise pins Node 26.5.0 / pnpm 10.13.1 and caches stage freshness. A green local
check with a red CI is usually the freshness cache — `mise run --force check`.
Lint enforces `--max-warnings 118` as a debt cap: lower it when you remove
warnings; never raise it.

## Layout

- `src/` — frontend, one directory per domain. Only 12 files sit at the root: `main.tsx`, `App.tsx`/`App.css`/`App.test.tsx`, `index.css`, `app-types.ts` (the shared domain model, 40 importers), `app-utils.ts` + its two tests, `i18n.ts` + test, `vite-env.d.ts`. There is deliberately **no `shared/`** — anything cross-domain enough to need one belongs at the root or in `components/ui/`. New work goes in the domain directory; place by who imports it, not by what it is called.
- `src/app/` — App orchestration: hooks extracted from `App.tsx` (`use-collab-v2-session.ts`, `use-overleaf-workspace.ts`, `notify.ts`) plus window/panel geometry.
- `src/canvas/` — the editing surface shell (`document-canvas.tsx`, editor tabs, toolbar, outline, `canvas-lazy-modules.ts`).
- `src/editor/` — editor infrastructure shared by more than one editor kind (CodeMirror host, language resolution, spellcheck), with `editor/latex/`, `editor/markdown/`, `editor/spreadsheet/`, `editor/board/`, `editor/insert/`, `editor/comments/` beneath it.
- `src/pdf/`, `src/build/`, `src/papers/`, `src/project/`, `src/history/`, `src/settings/`, `src/onboarding/`, `src/agent/` (Synara), `src/telemetry/` (logs, toasts, updater, error boundary, sounds), `src/platform/` (polyfills, perf probe, test setup, repo-level guard tests).
- `src/components/ui/` — the one UI-primitive home: shadcn-style controls plus the app-level shared presentation (`motion.tsx`, `resizable-drawer.tsx`, `avatar-group.tsx`, `confirm-action-dialog.tsx`, `search-picker-dialog.tsx`, `collab-colors.ts`).
- `src/overleaf/` — Overleaf sync: the OT engine (`ot-*`), the realtime/chat/comments/track-changes hooks (`use-overleaf-*`), and their panels and stylesheets.
- `src/collab/` — Lattice Shares (Yjs collaboration v2): the controller, text/binary clients, session and credential plumbing, chat and dialog UI.
- Filenames keep their domain prefix after a move (`collab/collab-session.ts`, not `collab/session.ts`) so the split stays a reviewable pure-rename diff.
- `src/open-knowledge-app/` — **vendored** from an upstream repo by `scripts/vendor-open-knowledge.mjs` (see its MANIFEST). Local patches are accepted practice but re-vendoring can overwrite them; prefer changes outside when possible. `src/open-knowledge-core/` is related but NOT auto-synced.
- `src-tauri/src/` — Rust: project validation/transactions (`project.rs`), LaTeX build (`latex.rs`), Overleaf sync (`overleaf*.rs`), papers/OpenAlex, TexLab, FTS, the Synara supervisor (`synara.rs`).
- `collab-server/` — Cloudflare Worker (Durable Objects) for Lattice Shares; own package.json; deploy with `pnpm collab:deploy`.
- `protocol/` — types shared between frontend and collab-server.
- `src-tauri/synara-runtime/` — staged agent runtime (gitignored); produced by `scripts/prepare-synara-sidecar.mjs` from the pinned source in `scripts/synara-runtime.json`.

## Collaboration v2 model

Every file is its own Y.Doc namespace `{projectInstanceId, fileId, documentEpoch}`.
The controller (`src/collab/collab-project-v2.ts`) owns a client pool (capacity 8, LRU
eviction of unpinned clean clients; pin names in `src/collab/collab-text-v2.ts`:
`main`, `secondary`, `chat`, `comments`).

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
  `src/agent/agent-canvas-tldraw-adapter.ts` behind the lazy board editor.
- `vite.config.ts` has `shikiTrimPlugin`: all shiki grammars/themes outside a
  runtime-reachable allowlist are stubbed. If new code can highlight more
  languages at runtime, extend the allowlist there.
- The eager startup graph is two application-owned chunks (`app`, `ui`) plus Vite 8's tiny `rolldown-runtime` preload, with a 1.35 MiB JavaScript budget enforced by `pnpm build`. `scripts/app-size-report.mjs` allowlists those names; the production build has a single html entry, so any third eager chunk means something changed the module grouping.
  Heavy libs (pdfjs, mermaid, katex, harper, codemirror langs, tiptap) must stay behind dynamic imports.
- `src-tauri/Cargo.toml` has a size-tuned `[profile.release]`; `panic = "abort"`
  is intentionally off (a panic must not kill the app with unsaved edits).
- `scripts/prepare-synara-sidecar.mjs` prunes the sidecar aggressively. If the
  runtime gains new imports, check the unreachable-packages list there;
  top-level `ajv`, `ajv-formats`, and the runtime JavaScript in `zod` must stay
  (undeclared runtime requires of the agent SDKs). The Claude SDK platform
  executable must remain a small PATH launcher: sessions use the user's CLI.

## Design-system contract (enforced by tests)

`src/styles/tokens.test.ts` fails the build when:
- spacing uses a raw px value that is on the scale — use `var(--space-*)` from `foundations.css`;
- palette tokens (`--bg`, `--text`, …) are referenced outside theme/foundations;
- a referenced custom property resolves nowhere.

`docs/design-system.md` records the typography/density decisions.

## Testing notes

- Vitest + jsdom + fake-indexeddb; collab tests stub `fetch` against a mock
  coordinator (see `setupCreateTest` in `src/collab/collab-project-v2.test.ts` — reuse
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
  Cargo.toml / Cargo.lock by `scripts/bump-version.mjs` only.
