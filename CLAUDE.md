# CLAUDE.md

Lattice — a local-first LaTeX writing app for macOS. Tauri 2 (Rust) shell +
React 19 / TypeScript / Vite 8 frontend, with a bundled AI-agent sidecar
(Synara) and Overleaf sync. Every build renders in the native WKWebView
window; see `docs/architecture.md` §1.

## Where to read

- Validation, a failed check, or a resumed session: read `docs/agent-validation.md` before choosing the next command.
- Finding the owner of a feature or cross-surface symptom, or placing a new file: `docs/codebase-map.md`.
- Startup imports or UI tokens: read `docs/architecture.md` (§4, §5) and `docs/design-system.md`; `pnpm build` and the token tests enforce the mechanical budgets.
- Screenshots, QA or measuring in the app: `docs/driving-the-app.md`.

## Commands and bootstrap

```bash
pnpm tauri dev                  # run the desktop app (needs the pinned Synara checkout, see below)
pnpm vitest run <file>          # one test file
node scripts/bump-version.mjs patch   # release: rewrites the version in package.json,
                                      # tauri.conf.json, Cargo.toml and Cargo.lock, then PRINTS
                                      # the add/commit/tag/push commands. It runs none of them —
                                      # pushing the tag yourself is what triggers CI to publish.
```

Only `pnpm tauri dev` / `pnpm tauri build` need the Synara source.
Everything else — including `cargo test` and `cargo clippy` — only needs a resource stub for the bundled Synara runtime:

```bash
mkdir -p src-tauri/synara-runtime
touch src-tauri/synara-runtime/placeholder.txt
```

For the real sidecar, clone `repository` from `scripts/synara-runtime.json` at
its pinned `revision` and point `SYNARA_SOURCE_DIR` at it (the default is
`sourceDirectory` in that same file and moves with the pinned branch — derive
it, don't hardcode it). See CONTRIBUTING.md and `scripts/setup-dev.sh`.

## Conventions

- Comments explain constraints the code can't show; match the existing
  comment-heavy style of tricky modules (Overleaf sync, App.tsx effects).
- Follow existing patterns for Tauri `listen()` cleanup (disposed-flag +
  unlisten race) and generation guards on async loads.
- Before publishing a Synara pin change, follow `docs/synara-runtime.md` and run `node scripts/check-synara-upgrade.mjs <previous-lattice-ref>` with the pre-upgrade Lattice ref.
  Preserve intended dirty/untracked fixes from the previous source checkout in the fork, and run the Lattice embed browser regressions; a clean upstream merge or successful build does not prove those behaviors survived.
