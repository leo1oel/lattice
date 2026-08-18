# Contributing to Lattice

Thanks for helping make Lattice a better research companion. Bug reports,
feature ideas, documentation improvements, and focused code contributions are
all welcome.

## Report a bug or suggest an improvement

Before opening an issue, please search the
[existing issues](https://github.com/leo1oel/lattice/issues) to see whether it
has already been reported.

For a bug, include:

- the Lattice version and your macOS version;
- clear steps to reproduce the problem;
- what you expected and what happened instead;
- relevant logs or screenshots, with private project content and credentials
  removed.

For a feature request, describe the research workflow you want to improve and
the problem you currently encounter. Explaining the use case is more useful
than prescribing a particular implementation.

[Open an issue](https://github.com/leo1oel/lattice/issues/new)

## Open a pull request

Small bug fixes and documentation improvements can go directly to a pull
request. For a substantial feature, protocol change, or large refactor, please
open an issue first so the direction can be discussed before implementation.

1. Fork the repository and create a branch from `main`.
2. Keep the change focused; avoid unrelated formatting or refactors.
3. Add or update tests for behavior that changes.
4. Run the relevant local checks described below.
5. Open a pull request that explains the problem, the chosen solution, and how
   you verified it. Link the related issue when there is one.

Do not bump the application version in a normal pull request. Releases are
prepared separately by maintainers; see
[`docs/release-process.md`](docs/release-process.md).

**Write the commit subject for a stranger.** Lattice has no `CHANGELOG.md` — the
release workflow builds each release's notes from the subjects of the commits in
that tag's range, so your subject line is what users read. "Fix crash when
opening a project with no root document" is a changelog entry; "fix bug" is not.

### Changes that need extra care

Most of the codebase takes an ordinary pull request. Two areas do not, because
in both the tests can keep passing while the thing they protect breaks:

- **The Overleaf bridge** (`src-tauri/src/overleaf.rs`,
  `src-tauri/src/overleaf_rt.rs`, `src/overleaf/`). Lattice speaks Overleaf's
  undocumented browser protocol, including a hand-written **Socket.IO 0.9**
  client — the legacy protocol, not the modern one every current library
  implements. UI and bug-fix work is fine, but a change to the wire format, the
  OT semantics, the permission model or persisted sync state has to arrive with
  a fixture that fails on the old behaviour and a rollback that does not discard
  local work. Read [`docs/overleaf-protocol.md`](docs/overleaf-protocol.md)
  first; it lists the specific "cleanups" that are not cleanups.
- **Lattice Shares collaboration** (`src/collab/`, `collab-server/`,
  `protocol/`). Every file is its own Y.Doc namespace and only the primary
  editor binding may activate one — everything else (secondary pane, saves,
  observers, chat, comments) must open it with `{ sideload: true }` or it
  silently unbinds the primary editor. See "The collaboration model" in
  [`docs/architecture.md`](docs/architecture.md).

Neither area is closed to contributions. Both just want an issue before a large
change, so the compatibility question gets answered before the code exists.

## Set up the project locally

You will need:

- Node.js and pnpm — [`mise.toml`](mise.toml) is the single source of truth for
  the exact versions (today: Node 26.5.0, pnpm 10.13.1). Installing
  [mise](https://mise.jdx.dev) and running `mise install` in the repository root
  gets you both at the right versions, and `pnpm check` needs mise anyway.
  Known gap: `.github/workflows/ci.yml` still runs Node 22, so CI and local
  development are not on the same major version. Nothing currently depends on
  the difference, but if you hit a Node-version-specific failure, that is why.
- stable Rust with `rustfmt` and `clippy`;
- the [desktop build prerequisites](https://v2.tauri.app/start/prerequisites/);
- Git and a TeX distribution that provides `latexmk`.

```bash
corepack enable      # only if you are not using mise
pnpm install
```

### You probably do not need to build the agent sidecar

**This is the part that trips up most new contributors.** Cargo compiles Tauri's
resource manifest, which expects `src-tauri/synara-runtime/` to exist — but the
tests never launch the sidecar. A stub file is enough:

```bash
mkdir -p src-tauri/synara-runtime && touch src-tauri/synara-runtime/placeholder.txt
```

With that one file in place, `pnpm check`, `cargo test`, and `cargo clippy` all
pass. Two of the three workflows do exactly this — see the "Stub the Synara
runtime resource for compilation" step in `.github/workflows/ci.yml` and
`.github/workflows/release-cache.yml`, neither of which ships a binary.
`.github/workflows/release.yml` is the only one that stages the real pinned
runtime, because it is the only one that packages the app.
`src-tauri/synara-runtime/` is gitignored, so the stub stays out of your
commits.

Unless you are changing the agent surface itself, stop here — you can run the
whole gate, the frontend dev server (`pnpm dev`), and every test without the
Synara source.

### Running the full desktop app

`pnpm tauri dev` and `pnpm tauri build` do need the pinned Synara source, and
they hard-fail with `Synara source is missing at …` when it is absent.

The location is not fixed: `scripts/prepare-synara-sidecar.mjs` reads
`SYNARA_SOURCE_DIR` and otherwise falls back to `sourceDirectory` in
[`scripts/synara-runtime.json`](scripts/synara-runtime.json), which moves
whenever the pinned branch does. Derive everything from that file rather than
hardcoding a path:

```bash
export SYNARA_SOURCE_DIR="$PWD/../synara"
git clone "$(node -p "require('./scripts/synara-runtime.json').repository")" "$SYNARA_SOURCE_DIR"
git -C "$SYNARA_SOURCE_DIR" checkout \
  "$(node -p "require('./scripts/synara-runtime.json').revision")"
# bun is a devDependency of this repo, so no global install is needed.
bun_bin="$PWD/node_modules/.bin/bun"
(cd "$SYNARA_SOURCE_DIR" && "$bun_bin" install --frozen-lockfile)

pnpm tauri dev
```

Keep `SYNARA_SOURCE_DIR` exported in the shell you run `pnpm tauri dev` from —
Vite's `.env.local` is not visible to the build scripts. If you would rather not
set it, clone into the path that `node -p
"require('./scripts/synara-runtime.json').sourceDirectory"` prints instead.

[`scripts/setup-dev.sh`](scripts/setup-dev.sh) automates all of this — mise and
the pinned toolchain, Rust, the stub, and the Synara checkout — but it targets
**Debian/Ubuntu** and will not run on macOS. It installs only into the
repository, `~/.local` and `~/.cargo`, and prints the `PATH` line for you to add
rather than editing your shell profile. Read it as executable documentation of
the correct bootstrap order.

Licensed whiteboard builds also require `VITE_TLDRAW_LICENSE_KEY` in
`.env.local`; see [`.env.example`](.env.example), which documents that and every
other environment variable this repository reads — including the collaboration
kill switches and the two credentials (`OPENALEX_API_KEY`,
`LATTICE_FIRECRAWL_KEY`) that must be exported in your shell rather than put in
`.env.local`, because Vite only loads `.env.local` for the frontend. If you add
a new one, add it there in the same commit.

## Verify your change

Run a focused test while iterating, then run the complete gate before opening a
pull request:

```bash
pnpm vitest run src/path/to/file.test.ts
pnpm check
```

`pnpm check` is `mise run check` and needs [mise](https://mise.jdx.dev). It runs
eight stages in parallel, skipping any whose declared `sources` have not
changed since the last successful run:

| Stage | What it runs |
| --- | --- |
| `i18n-check` | catalog extraction, drift check, compile, coverage guard |
| `lint` | ESLint over `src/` |
| `test` | the Vitest suite |
| `build` | typecheck plus the production web bundle and its size budget |
| `collab-server` | `typecheck` and `test` inside `collab-server/` |
| `cargo-fmt` | `cargo fmt --check` |
| `cargo-test` | the Rust tests |
| `clippy` | Clippy with warnings denied |

That covers `collab-server/` too, so there is nothing extra to run for a change
in there. [`mise.toml`](mise.toml) is the definition; keep it and this table in
step.

The commands are the same ones CI runs, but the environments are not
interchangeable: CI runs everything from a clean checkout with nothing skipped,
on Node 22 (Rust on macOS, the rest on Ubuntu), while `pnpm check` runs on the
Node and pnpm versions `mise.toml` pins and skips stages it considers fresh. If
a stage passes locally and fails in CI, suspect the freshness cache first —
`mise run --force check` re-runs everything.

## Work in the right area

| Path | What belongs there |
| --- | --- |
| `src/` | The desktop interface, editors, collaboration clients, and frontend tests |
| `src-tauri/src/` | Project operations, LaTeX builds, Git, papers, Overleaf, and agent supervision |
| `protocol/` | Contracts shared by the app and collaboration server |
| `collab-server/` | Lattice Shares server and its tests |
| `docs/` | Design decisions and subsystem documentation for contributors |

`src/open-knowledge-app/` is vendored from an upstream project and can be
overwritten when it is refreshed. Prefer changes outside it when practical.

If you are unsure where a change belongs, open an issue with the intended user
experience before investing in a large implementation.

## Licensing

Lattice is licensed under the **GNU General Public License, version 3 or later**
(see [`LICENSE`](LICENSE)). By opening a pull request you agree that your
contribution is offered under those terms. There is no CLA and no copyright
assignment.

The project is GPL because it vendors and links GPL-3.0-or-later code from
[Inkeep Open Knowledge](https://github.com/inkeep/open-knowledge). Three trees
carry that inheritance, and each has rules:

| Tree | What it is | Rule |
| --- | --- | --- |
| `src/open-knowledge-app/` | Vendored verbatim from upstream `packages/app/src` | Regenerate with `node scripts/vendor-open-knowledge.mjs`; `open-knowledge-app.lock.json` is the manifest. Do not hand-edit vendored files — local changes belong in the seam files, which carry a `Local seam — not upstream code` header. |
| `src/open-knowledge-core/` | Vendored subset of upstream `packages/core/src` | Not auto-synced. Any intentional change must keep its `Local deviation from upstream` comment. |
| `src/visual-*` | Lattice code adapted from upstream | Each file's adaptation header names the upstream file and commit. **Preserve those headers** — they are the per-file attribution GPLv3 §5 requires. |

Both vendored trees also carry a copy of the GPL at
`src/open-knowledge-{app,core}/LICENSE`. Do not remove them.

When you add a dependency, adapt code from elsewhere, or bundle an asset, record
it in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md). That file also lists
the attribution gaps that are known and still open; adding to that list is a
perfectly good contribution.
