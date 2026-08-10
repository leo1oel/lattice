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
prepared separately by maintainers.

## Set up the project locally

You will need:

- Node.js 22.13 or later and pnpm 10;
- stable Rust with `rustfmt` and `clippy`;
- the [desktop build prerequisites](https://v2.tauri.app/start/prerequisites/);
- Git and a TeX distribution that provides `latexmk`;
- a sibling checkout of the pinned Synara source.

From the Lattice repository root:

```bash
git clone https://github.com/leo1oel/synara.git ../synara-poc
git -C ../synara-poc checkout "$(node -p \
  "JSON.parse(require('node:fs').readFileSync('scripts/synara-runtime.json', 'utf8')).revision")"

corepack enable
corepack prepare pnpm@10 --activate
pnpm install
pnpm tauri dev
```

`pnpm tauri dev` prepares the pinned agent runtime and starts the complete
desktop app. Licensed whiteboard builds also require
`VITE_TLDRAW_LICENSE_KEY` in `.env.local`; see [`.env.example`](.env.example).

## Verify your change

Run a focused test while iterating, then run the complete gate before opening a
pull request:

```bash
pnpm vitest run src/path/to/file.test.ts
pnpm check
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
```

`pnpm check` runs linting, frontend tests, the production web build, Rust tests,
and Clippy with warnings denied. Changes under `collab-server/` should also run:

```bash
pnpm --dir collab-server typecheck
pnpm --dir collab-server test
```

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
