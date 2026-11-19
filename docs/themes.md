# Themes

A theme recolors Lattice. It is data, not code: one `lattice-theme.json`
file that gives literal colors to the design system's base roles. Both apps
read the same file, resolve it with the same Rust code
([`src-tauri/lattice-theme`](../src-tauri/lattice-theme)), and derive every
other color from it the way they already derive them from the default
palette. A theme cannot change sizes, spacing, fonts or behavior, and it
cannot run anything, so installing one asks for no permission and works on
every platform.

The design behind this is in the Captain drive's
`plans/plugin-market-and-theming.md` (decisions L1–L13, approved 2026-11-18).

## The format

```json
{
  "$schema": "https://lattice-writer.github.io/lattice-plugins/schema/theme-1.json",
  "schema": 1,
  "id": "dev.example.my-theme",
  "name": "My theme",
  "version": "1.0.0",
  "author": "Example",
  "license": "MIT",
  "description": "One sentence.",
  "variants": [
    {
      "id": "day",
      "name": "My theme Light",
      "appearance": "light",
      "colors": { "chrome": "#f2e9e1", "text": "#575279", "accent": "#907aa9", "line": "#5752791a" },
      "syntax": { "keyword": "#286983", "comment": "#9893a5" },
      "terminal": { "red": "#b4637a" }
    }
  ]
}
```

- **`id`** is reverse-domain and lower case. `app.lattice.*` belongs to the
  themes that ship with Lattice.
- **Variants:** one to eight, each for `light` or `dark`. Lattice uses the
  first variant for the appearance the window has. A theme with only a dark
  variant leaves the light appearance as Lattice's own.
- **Values are literal `#RRGGBB` or `#RRGGBBAA`.** No `var()`, `color-mix()`,
  names or functions: the GPUI app has no CSS engine, and literals keep the
  file safe to apply. Roles that color text must be opaque.
- **Every role is optional.** A role a theme leaves out keeps Lattice's own
  color for that appearance.
- Unknown top-level keys are ignored (a theme written for a newer Lattice
  still loads). An unknown role is an error. Files are at most 256 KiB.

The JSON Schema, generated from the role tables, is
[`design-system/themes/theme-1.schema.json`](../design-system/themes/theme-1.schema.json).

### Roles

| Section | Roles | Held to |
|---|---|---|
| `colors` surfaces | `window`, `chrome`, `panel`, `raised`, `input`, `editor`, `pdf-ground` | used as given |
| `colors` inks | `text`, `text-secondary` | 4.5:1 on every surface |
| `colors` lines | `line`, `line-strong` (usually translucent) | used as given |
| `colors` accent | `accent`, `focus`, `selection` | accent 4.6:1 on the chrome, panels and editor |
| `colors` status | `danger`, `success`, `warning`, `info`, `annotation` | 4.5:1 on the panel and lift |
| `syntax` | the 16 token roles of `design-system/code-themes.json` | 4.5:1 on the editor |
| `terminal` | `black` … `white`, `bright-black` … `bright-white` | used as given |

"Held to" means a color that does not read is moved, keeping its hue, to the
nearest one that does (`lattice_theme::color::fit_contrast`). The surfaces
are the theme's own, or Lattice's where it leaves one out.

Derived colors are not themeable: hover and pressed washes, the soft accent,
the titlebar veil, the status washes, the selection surface. Each app derives
them from the base roles. That keeps every interaction state consistent with
the theme, including states added later.

The side panels' surface (Project, Papers, Literature, the Agent) is derived
too, once, by `lattice-theme` for both apps: the theme's `chrome`, unless it
sits within half a tone of OKLCH lightness of the `editor`, in which case it
is the editor a tone darker (`color::side_panel`). The Tauri app gets it as
`--side-panel` among the theme's variables; the GPUI app as
`Resolved::side_panel`.

## Choosing a theme and an accent

- A theme replaces the tint: while one is in effect the app stands on
  Graphite and the theme sets the roles it names.
- **Accent (decision L13):** `Theme default` (`accent: "theme"`) takes the
  theme's accent, or Graphite's when there is no theme or it has none. An
  accent the writer picks (a preset or a custom color) wins over the theme's,
  fitted to the theme's surfaces.
- A theme that colors the syntax wins over the Code theme setting while it is
  chosen.
- The choice is `appearance.theme` (the id, or `""`) in the shared settings
  both apps read.

## Where themes live

`lattice-core::themes::ThemeStore` lists the bundled themes
(`design-system/themes/*.lattice-theme.json`, compiled in) and the installed
ones in `<app data>/themes/<id>.json`. Installing validates the file and keeps
a copy; the picked file can move or change afterwards. Nothing in a project
folder installs or selects a theme.

## The theme marketplace

`lattice-core::registry::Registry` reads the signed list that
[lattice-writer/lattice-plugins](https://github.com/lattice-writer/lattice-plugins)
publishes to GitHub Pages (`index.json`, `blocked.json` and their `.minisig`
files). Lattice reads it from <https://lattice-writer.github.io/lattice-plugins>
first and falls back to <https://leo1oel.github.io/lattice-plugins>, the
address before the move, which mirrors the same signed files for releases
from before it. Trust comes from the signatures, so both addresses are equal.

- **Signatures.** Each file must verify against one of the two minisign keys
  compiled into `registry/verify.rs` (primary and backup, so the registry can
  rotate without a release), and its trusted comment must read
  `lattice-plugins file:<name> serial:<serial>` with the file's own name and
  serial. Both files must carry the same serial.
- **Rollback.** The last verified pair is cached in
  `<app data>/registry/cache.json` and verified again on every read. A list
  whose serial is lower than the cached one is refused and the cache stays;
  so does one that fails verification. Offline, the cache is served with the
  time it was fetched.
- **Installing** downloads the theme's `url`, checks its size and sha256
  against the signed index, and installs it through `ThemeStore::install_text`.
  `<app data>/registry/installed.json` records the version, so an update is
  offered when the index lists a higher one.
- **Block list.** A theme whose id and version fall under a `blocked.json`
  entry (`*` or an npm-style range) is not installed, and an installed
  registry theme that becomes blocked is reported with the entry's reason.
  Themes installed from a file are never matched.
- **Kill switch.** `Registry::resolve` and `Registry::list_themes` read the
  block list from the verified cache only. A chosen registry theme whose
  installed version falls under an entry with any action but `warn` resolves
  as no theme, so both apps draw Lattice's own colors while the choice stays
  stored, and the Palette row says "<name> was turned off: <reason>". A
  `warn` entry leaves the theme applied and shows its warning there.
- **Browse themes** (Settings › Appearance › Theme files) is a sheet over
  Settings: search over name, description and author, a status line (updated,
  offline with the cached list's date, or a verification failure, during
  which nothing installs), and one row per theme with a tile painted from the
  index's colors, so nothing downloads before Install. Install chooses the
  theme with the same accent rule as a file install; Update keeps the choice.
  GPUI draws the same sheet (`gpui/crates/lattice-gpui/src/settings/theme_browse.rs`),
  calling `Registry` off the main thread, and `settings::reload_theme` asks
  `Registry::turned_off` before it applies a theme file.

The Tauri commands are `registry_index` (`refresh: true` fetches first) and
`registry_install_theme` in `src-tauri/src/ipc/themes.rs`.

## How each app applies a theme

- **Tauri:** `src/settings/use-appearance.ts` asks `themes_resolve`
  (`src-tauri/src/ipc/themes.rs`) and sets the returned base CSS variables
  (`--bg`, `--chrome-surface`, `--text`, `--accent`, `--syntax-*`, …) on
  `<html>`. theme.css and foundations.css derive everything else. The last
  answer per choice is cached in localStorage, so a window opens in its theme
  without a frame of the default.
- **GPUI:** `Palette::with_theme` (`gpui/crates/lattice-ui/src/palette.rs`)
  lays the resolved roles over Graphite and derives the same roles in Rust.
  The code palette and the terminal take the theme's syntax and ANSI colors.

## Keeping the two apps equal

- **One fitter.** Accent and theme fitting run only in
  `lattice_theme::color`. The Tauri app asks for it over IPC
  (`themes_fit_accent`, `themes_resolve`). The TypeScript `fitContrast` that
  the build-time code-theme export and the highlight palette still use is held
  to the Rust one by `src/settings/color-parity.test.ts`, over vectors the
  Rust tests write (`design-system/themes/color-vectors.json`).
- **Parity.** `gpui/crates/lattice-ui/src/theme_parity.rs` writes what GPUI
  derives for every bundled theme, appearance and kind of accent to
  `design-system/themes/parity.json`. `src/settings/theme-parity.test.ts`
  evaluates theme.css and foundations.css on the same variables and must reach
  the same colors.

Regenerate after changing roles, derivations or bundled themes:

```sh
LATTICE_UPDATE_THEME_SCHEMA=1 cargo test -p lattice-theme          # schema + color vectors
LATTICE_UPDATE_THEME_PARITY=1 node scripts/gpui-build.mjs -- test --release --locked -p lattice-ui theme_parity
cp ~/Library/Caches/lattice-gpui-build/lattice/design-system/themes/parity.json design-system/themes/
pnpm vitest run src/settings/theme-parity.test.ts src/settings/color-parity.test.ts
```

## Bundled themes

Rosé Pine (Dawn and Main) and Nord (Snow Storm and Polar Night), both MIT,
mapped onto Lattice's roles. See THIRD_PARTY_NOTICES.md.
