# Release process

How a Lattice release is actually cut today. Everything below is derived from
`scripts/bump-version.mjs`, `.github/workflows/release.yml`,
`.github/workflows/linux-appimage.yml`, `.github/workflows/macos-intel.yml`,
`.github/workflows/release-cache.yml`,
and `src-tauri/tauri.conf.json`; if you change one of those, change this
document with it.

Releases target **Apple silicon macOS** (`--target aarch64-apple-darwin`,
`minimumSystemVersion: 14.0`). An **Intel-based Mac** build (`x86_64-apple-darwin`,
[below](#macos-intelyml)) and an **experimental x86_64 Linux AppImage**
([below](#linux-appimageyml)) are added to the release afterwards, each only
when its own checks pass; neither ever delays or blocks the Apple silicon
release.

An independent **experimental Windows x64 NSIS installer** can also be attached
after its own install, native-app and uninstall checks pass. See
[Windows installer](windows-installer.md) and
`.github/workflows/windows-installer.yml`. It uses open-licensed fonts, is
unsigned, keeps the Agent disabled and provides manual updates only. Its
namespaced installer, checksum, build information and SmartScreen instructions
are public release assets. It never delays the Mac release or edits its assets,
notes or updater metadata. Authenticode and Windows updater work remain separate.

## Cut a release

```bash
node scripts/bump-version.mjs patch     # or: minor | major | 0.3.0
```

The script only edits files — it does not commit or tag. It bumps the version in
lockstep across `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, `src-tauri/lattice-core/Cargo.toml`, the
`research-writer` and `lattice-core` entries in `src-tauri/Cargo.lock`, and the
`lattice-core` entry in `gpui/Cargo.lock` (the GPUI preview app builds on
`lattice-core` with `--locked`), and writes the What's new notes (below), then
prints the exact next commands:

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/lattice-core/Cargo.toml src-tauri/Cargo.lock gpui/Cargo.lock src/release-notes/X.Y.Z.json
git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push origin main
git push origin refs/tags/vX.Y.Z
```

Pushing the **tag** is what triggers the release. The workflow listens on
`push: tags: [v*]`.

## Where the changelog lives

**GitHub Releases is the changelog. There is deliberately no `CHANGELOG.md`.**

<https://github.com/leo1oel/lattice/releases>

The reasoning, so nobody re-opens this without new information:

- The notes are **generated, not curated** — step 2 below builds them from the
  commit range between the new tag and the nearest released ancestor. That makes
  them complete by construction. A hand-maintained file would be complete only
  as long as somebody remembered, and there is no CI step that could enforce it.
- The cadence makes a hand-written file untenable. There are **192 tags**, mostly
  same-week patch releases. A `CHANGELOG.md` seeded from "the recent tags" would
  either duplicate the generated notes or, worse, imply the ~170 earlier releases
  went undocumented — which is false; every one of them has notes.
- Retro-fitting Keep a Changelog honestly is not possible here. The history has
  no conventional-commit discipline, so categorising 192 releases into
  Added/Changed/Fixed would mean guessing at commit subjects nobody re-verified.
  That is the exact failure mode this documentation pass exists to remove.
- One source of truth beats two. If both existed, the generated one would be
  right and the written one would drift.

The consequence for contributors is real and is stated in
[`../CONTRIBUTING.md`](../CONTRIBUTING.md): **a commit subject is a changelog
entry.** It is what a user reads in the release notes.

The consequence for maintainers is that anything a generated line cannot convey
— a minor version's highlights, a breaking change, a migration, the updater-key
rotation warning below — goes in `.github/release-notes/vX.Y.Z.md`, committed
with the version bump. The workflow puts that file above the generated list, so
the lead is reviewed with the bump instead of being edited into a published
Release. It is per-release and optional, not a running changelog.

The same lead feeds the app's What's new sheet. Write it before running
`bump-version.mjs`, which then writes `src/release-notes/X.Y.Z.json` from its
highlights and fixes (`scripts/release-notes.mjs`) with the Chinese left
empty; fill in every `zh` before the release commit
(`src/release-notes/release-notes.test.ts` fails on an empty one). A release
without a lead keeps showing the last one that had one.

## What `release.yml` does

One job on `macos-latest` (Apple silicon), with `contents: write` so it can
create the Release and upload assets.

1. **Checkout** with `fetch-depth: 0` — the release notes need the full tag
   history.
2. **Generate release notes.** Finds the nearest released ancestor tag with
   `git describe --tags --abbrev=0 <tag>^`, lists every non-merge commit in that
   range as `- <subject> (<short hash>)`, and skips the `Release v…` commit
   itself. Falls back to "Maintenance release." when the range is empty. Puts
   `.github/release-notes/<tag>.md` above that list when the file exists. Appends
   the Apple silicon install blurb and a `**Full Changelog**` compare link, then
   passes the whole thing to the build step through a heredoc-delimited
   `$GITHUB_OUTPUT`.
3. **Toolchains.** pnpm 10, Node 22, Bun 1.4.4, stable Rust with the `aarch64-apple-darwin` target.
4. **Rust cache.** `Swatinem/rust-cache@v2` reads the warm dependency build produced by `release-cache.yml` on `main`.
   Its shared key includes `bundle.macOS.minimumSystemVersion`, because Tauri exports that value as `MACOSX_DEPLOYMENT_TARGET` before compiling and Cargo cannot reuse artifacts warmed without it.
   `save-if: false` prevents the tag build from writing a cache no later release could read.
5. **`pnpm install --frozen-lockfile`.**
6. **Fetch the pinned Synara source.** The workflow reads `repository` and `revision` from `scripts/synara-runtime.json`, shallow-fetches exactly that revision into `$RUNNER_TEMP/lattice-synara`, asserts `HEAD` equals the pin, and exports `SYNARA_SOURCE_DIR` and `BUN_BIN`.
7. **Fetch the licensed interface fonts.** With the `LATTICE_FONTS_DEPLOY_KEY` secret, the workflow clones the private `leo1oel/lattice-fonts` repository into `$RUNNER_TEMP/lattice-fonts` and exports `LATTICE_PRIVATE_FONTS_DIR` and `LATTICE_PRIVATE_FONTS_REQUIRED=1`, so a missing or incomplete copy fails the build; without the secret it builds with the open-licensed fonts. See [`design-system.md`, "Private interface fonts"](design-system.md#private-interface-fonts).
8. **Import the Apple Developer ID certificate.** The workflow base64-decodes `APPLE_CERTIFICATE` into a `.p12`, creates a throwaway keychain, imports the certificate with `-T /usr/bin/codesign`, sets the key partition list so codesign can use it without prompting, makes it the active keychain, finds the `Developer ID Application` identity, and exports it as `APPLE_SIGNING_IDENTITY`.
9. **Restore the prepared Synara runtime.** The restore-only cache is written on `main` and keyed by the target platform, `scripts/synara-runtime.json`, and `scripts/prepare-synara-sidecar.mjs`.
   A miss runs `bun install --frozen-lockfile` and lets `pnpm prepare:build` build the runtime normally.
   A hit lets the preparation script validate the source-derived manifest and re-sign the cached unsigned binaries with the current Developer ID certificate without rebuilding Synara's four-minute web bundle.
10. **Prepare the App Store Connect API key.** The workflow writes `APPLE_API_PRIVATE_KEY` to `$RUNNER_TEMP/AuthKey_$APPLE_API_KEY.p8` with mode 600 and exports `APPLE_API_KEY_PATH`.
11. **Build, sign, and publish** with `tauri-apps/tauri-action@v1`:
   - `args: --target aarch64-apple-darwin` (this is what makes the updater
     platform key `darwin-aarch64`);
   - `releaseDraft: true` — the Release stays a **draft** until verification
     passes;
   - `uploadUpdaterJson: true` — generates and uploads `latest.json`, which the
     in-app updater reads from
     `https://github.com/leo1oel/lattice/releases/latest/download/latest.json`
     (see `plugins.updater.endpoints` in `tauri.conf.json`);
   - `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` sign the updater artifact
     (`bundle.createUpdaterArtifacts` is on);
   - `LATTICE_FIRECRAWL_KEY` is compiled into the binary here via `option_env!`
     in `src-tauri/lattice-core/src/literature_credentials.rs`. It is extractable from the shipped app —
     that is a known and accepted trade-off; rotate it on abuse.
12. **Check the built app for loose font files** with
    `node scripts/check-font-leaks.mjs app <Lattice.app>`, before it is packaged
    any further.
13. **Notarize.** `xcrun notarytool submit <dmg> --wait` with the API key, then
    `xcrun stapler staple <dmg>`.
14. **Verify before publishing.** On the DMG: `codesign --verify --strict`,
    `spctl --assess --type open --context context:primary-signature`, and
    `xcrun stapler validate`. Then it mounts the DMG and repeats on the `.app`
    inside: `codesign --verify --deep --strict`, `spctl --assess --type
    execute`, `xcrun stapler validate`.
15. **Upload the stapled DMG** with `gh release upload --clobber` (the stapled
    ticket is added after tauri-action's own upload, so the asset is replaced).
16. **Check the release assets for font files.** Downloads the draft's assets
    and runs `node scripts/check-font-leaks.mjs assets <dir>`: only the signed
    artifacts and `latest.json`, none of them a font.
17. **Publish** with `gh release edit "$GITHUB_REF_NAME" --draft=false`.

If any verification step fails, the Release simply stays a draft and nothing
reaches users.

### `linux-appimage.yml`

The Linux AppImage is built after the Mac release, not beside it, so it cannot
change what Mac users get: `release.yml` does not mention Linux, and this
workflow starts from its `workflow_run` event only once a tag's Release run
has **succeeded**, that is, once the Mac release is published. A Release run
that fails starts nothing here; a Linux failure leaves the published release
as it is, without an AppImage, and keeps the Release run (which `web-demo.yml`
waits on) green.

From the release's commit (`workflow_run.head_sha`), on GitHub's runners:

1. **build** (`ubuntu-22.04`, so the AppImage's glibc floor is 22.04's):
   `pnpm tauri build --bundles appimage` with the same pinned Synara source,
   licensed fonts, Firecrawl key and tldraw key as the Mac build, then
   `.github/scripts/unbundle-wayland-client.sh`, which rebuilds the AppImage
   without the `libwayland-client` linuxdeploy bundled from 22.04 (the host's
   Mesa needs the host's own, or WebKit cannot create its EGL display and the
   window stays empty), then
   `check-font-leaks.mjs assets` on the AppImage alone (an allowed asset name,
   not a font) and `check-font-leaks.mjs appdir` on its extracted contents
   (no Timeless file outside the binary, no font outside the bundled
   runtimes under `usr/lib/Lattice/`).
2. **smoke** (Docker guests `ubuntu:22.04`, `ubuntu:24.04`, `ubuntu:26.04`,
   `fedora:45`, with GTK 3, Mesa and Xvfb): `.github/scripts/smoke-appimage.sh`
   extracts the AppImage, requires every bundled ELF to resolve its libraries
   and its glibc/libstdc++ versions, and requires the app to still be running
   20 s after launch under Xvfb, with WebKit's web process still running at
   15 s (when it dies, the app stays up with an empty window). A stand-in
   `latexmk` the app starts must run through `/usr/bin/env` with none of the
   AppImage's folders in its environment (`src-tauri/lattice-core/src/commands/appimage.rs`).
3. **e2e** (`ubuntu-22.04`, TeX Live from apt): `tauri-driver` with
   WebKitGTK's `WebKitWebDriver` launches the AppImage itself under Xvfb, and
   `scripts/linux-e2e.mjs` checks that the first launch opens the tutorial,
   its build succeeds and the PDF draws page 1, **Build** rebuilds it, and
   the Agent panel shows the Agent, started inside its `.bib` guard, or says
   which of bubblewrap, FUSE and user namespaces the runner lacks. A failure
   uploads a screenshot and the page text as `linux-e2e-evidence`.
4. **attach**, only after all three: `gh release upload --clobber` of the one
   `Lattice_<version>_amd64.AppImage` (a re-run replaces it; the job fails if
   the release then holds anything but exactly one AppImage), then appends an
   "Install (Linux, experimental)" section to the release notes once.

**Linux copies do not update themselves.** The build passes
`--config '{"bundle":{"createUpdaterArtifacts":false}}'`, so no updater
artifact is made or signed for Linux, and `latest.json` has no Linux
entry; the release notes tell Linux users to download each
release. On Linux the app does not register the updater plugin
(`src-tauri/src/lib.rs`). A separate notice checks the latest release metadata
for an AppImage and links to GitHub Releases; Settings → App updates also links
to the latest release. Offering in-app updates on Linux would mean signing the
AppImage
with `TAURI_SIGNING_PRIVATE_KEY` and merging a `linux-x86_64` entry into
`latest.json`, as `macos-intel.yml` does for `darwin-x86_64`.

When a release's Linux checks fail, re-running the failed jobs of that tag's
Linux AppImage run only retries a transient failure (a runner, the network, an
apt mirror). A re-run keeps the workflow file the original run started from
and checks out the tag's commit for the scripts it runs, so a fix to the
workflow or to the code, merged on `main`, takes effect at the next tagged
release; until then that release has no AppImage.
A pull request that changes the packaging (the workflow, the smoke script,
`unbundle-wayland-client.sh`, `scripts/linux-e2e.mjs`, `scripts/check-font-leaks.mjs` or the runtime pruning
in `scripts/lib/runtime-prune.mjs`) runs steps 1–3
with the open-licensed fonts and no baked-in keys, and attaches nothing; so
does a manual `workflow_dispatch` run.

### `macos-intel.yml`

The Intel-based Mac build follows the Linux AppImage's pattern: `release.yml` does
not mention it, and it starts from Release's `workflow_run` event only once a
tag's Release run has **succeeded**. An Intel failure leaves the published
release without its `_x64` assets and `latest.json` without `darwin-x86_64`:
Intel copies stay on their version until a release whose Intel build passes,
and nothing changes for Apple silicon. It is a separate app rather than a
universal binary, which would double the Apple silicon download.

From the release's commit, on GitHub's runners:

1. **build** (`macos-15-intel`): the native host is what makes the bundle
   x86_64 throughout — `prepare-synara-sidecar.mjs` stages the Node release
   for rustc's host triple, and the presentation runtime keeps the host's
   native packages. `pnpm tauri build --target x86_64-apple-darwin --bundles app,dmg`
   with the Developer ID, App Store Connect key and updater key that
   `release.yml` uses (so the app is signed and notarized and its updater
   archive signed), the licensed fonts and the Firecrawl and tldraw keys. Then
   `check-font-leaks.mjs app`, `app-size-report.mjs`,
   `.github/scripts/check-macos-arch.sh` (every Mach-O file in the bundle
   must contain x86_64), DMG notarization and stapling, and the same
   `codesign`/`spctl`/`stapler` verification as the Apple silicon release.
   Each `stapler` call goes through `.github/scripts/retry-stapler.sh`,
   which retries the CloudKit ticket lookup the Intel runners have dropped.
   `tauri build` staples the app once and ignores a failure, so before the
   DMG is notarized `.github/scripts/staple-dmg-app.sh` staples the app
   inside it when its ticket is missing (v0.16.6's first attempt).
   The app's own downloads follow its architecture: the managed `uv`
   (`src-tauri/lattice-core/src/tex_setup/installer.rs`) and rtex for live preview
   (`src-tauri/lattice-core/src/live_preview/install.rs`) pin one archive per CPU.
2. **smoke** (a fresh `macos-15-intel`): `.github/scripts/smoke-macos-dmg.sh`
   installs the app from the DMG, runs the bundled Node (which must report
   `x64`), checks Gatekeeper accepts the app, launches it, and requires a
   Lattice window on screen and the frontend's events in `lattice.log`. Its
   screenshot and log are uploaded as `macos-intel-smoke-evidence`.
3. **attach**, only after both: stops if `latest.json` already lists a
   `darwin-x86_64` archive with a different signature (a full re-run's new
   build), then uploads `Lattice_<version>_x64.dmg`,
   `Lattice_<version>_x64.app.tar.gz` and its `.sig` with `--clobber`, then
   `scripts/add-updater-platform.mjs` verifies the archive's signature against
   `plugins.updater.pubkey` and adds `darwin-x86_64` and `darwin-x86_64-app`
   to the release's `latest.json`, leaving the `darwin-aarch64` entries as
   they were; finally it appends an "Install (Intel-based Mac)" section to the
   release notes once.

The Apple silicon asset names are unchanged, so the website's main Download
and the `darwin-aarch64` updater URLs keep working; the website links the
`_x64.dmg` separately. As with Linux, a re-run uses the original workflow file
and the tag's code, so a fix merged on `main` takes effect at the next release.
`macos-intel-retry.yml` re-runs a release's Intel run once when its first
attempt fails: the failed jobs when one failed, or the whole run when GitHub
failed it without creating smoke and attach (v0.16.4's "Internal server
error", which `gh run rerun --failed` refuses). An attempt whose attach
succeeded is left alone, and a second failure stays red.
A pull request that changes this packaging, or a manual `workflow_dispatch`
run, runs build and smoke with the open-licensed fonts, no baked-in keys and
no updater key (so no updater archive) — signed and notarized when the
repository's secrets are available — and attaches nothing.

### `web-demo.yml`

Once the Release workflow succeeds, `web-demo.yml` builds the website's interactive demo (`tools/web-demo/`, `node scripts/web-demo.mjs`) from the release's commit and publishes it to the `gh-pages` branch under `demo/`, so <https://leo1oel.github.io/lattice/demo/> always runs the version people download.
It writes nothing outside `demo/`: the rest of `gh-pages` is the website.
The build is checked before anything is published (no Timeless font, by name or by bytes; no bench or tldraw code; the startup download within its budget; the app opens in headless Chrome), and a failed check leaves the previous demo up.

### `release-cache.yml`

A separate workflow on `main` warms two caches in parallel.
A push that changes no Rust input, such as a Synara pin bump, skips the Rust job; the weekly schedule and a manual run warm both.
The Rust job compiles the release dependency graph with the same target and `MACOSX_DEPLOYMENT_TARGET` as Tauri, so a nominal cache hit does not trigger a second macOS dependency build inside the release.
It deliberately does **not** set `LATTICE_FIRECRAWL_KEY`, and `rust-cache` removes the workspace crate before saving, so the key never lands in a cache artifact.

The Synara job builds and stages the pinned runtime without a Developer ID certificate, then saves that unsigned directory on the default branch where tag workflows can restore it.
The release re-signs the restored native binaries before Tauri packages them.
Changing the Synara pin or preparation script creates a new cache key; the first release can still build on a miss, while later releases restore the warmed result.

## Required GitHub secrets

| Secret | Used for |
| --- | --- |
| `APPLE_CERTIFICATE` | Base64-encoded Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password for that `.p12` |
| `KEYCHAIN_PASSWORD` | Password for the temporary CI keychain (any value) |
| `APPLE_API_KEY` | App Store Connect API **key ID** (also names the `.p8` file) |
| `APPLE_API_ISSUER` | App Store Connect API issuer ID |
| `APPLE_API_PRIVATE_KEY` | Contents of the App Store Connect `.p8` private key |
| `TAURI_SIGNING_PRIVATE_KEY` | Updater signing private key (minisign) |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Password for it (empty string for the current key) |
| `LATTICE_FIRECRAWL_KEY` | Shared Firecrawl key baked into release builds |
| `VITE_TLDRAW_LICENSE_KEY` | tldraw license key inlined into the board editor; without it the release ships tldraw in its unlicensed, watermarked mode |
| `LATTICE_FONTS_DEPLOY_KEY` | Read-only SSH deploy key for the private `leo1oel/lattice-fonts` repository (optional; without it the release ships the open-licensed fonts) |

`GITHUB_TOKEN` is provided automatically by Actions; it does not need to be
created.

## Forks cannot produce signed or notarized builds

None of the Apple secrets are available to a fork, and the updater private key
is not in the repository. A fork that pushes a `v*` tag will fail at the
certificate-import step (`security find-identity` finds no
`Developer ID Application` identity and the `test -n` assertion fails).

What a fork can do instead:

- `pnpm tauri build --target aarch64-apple-darwin` locally. Without an Apple
  Developer ID this produces an ad-hoc-signed app (`signingIdentity: "-"` in
  `tauri.conf.json`), which macOS Gatekeeper will quarantine on first open.
  Users must right-click → Open, or clear the flag with
  `xattr -dr com.apple.quarantine /Applications/Lattice.app`.
- Ship without the in-app updater, or point
  `plugins.updater.endpoints` at your own release host and sign updater
  artifacts with your own key pair (see below). Updater artifacts built without
  `TAURI_SIGNING_PRIVATE_KEY` are unsigned and the installed app will refuse
  them.
- Set your own `LATTICE_FIRECRAWL_KEY`, or ship without one — webpage import
  then asks the user for a key.

## Build Lattice Beta

Lattice Beta is the same source built as a second app that installs and runs
beside the release one. It is never published; `release.yml` builds only the
release flavor, which `tauri-security-config.test.ts` checks.

```bash
pnpm build:beta                  # extra tauri build flags go after it, e.g. --bundles app
```

That is `LATTICE_FLAVOR=beta tauri build --config src-tauri/tauri.beta.conf.json`,
and it needs both halves:

- `src-tauri/tauri.beta.conf.json`, merged over `tauri.conf.json`, gives the
  identity: identifier `app.leo1oel.researchwriter.beta`, product and binary
  name `Lattice Beta`, and no updater endpoint or artifacts. App data, caches,
  logs, WebKit data, managed tools and the literature keychain item all derive
  from the identifier (`src-tauri/lattice-core/src/app_identity.rs`), so Beta never touches
  the release app's.
- `LATTICE_FLAVOR=beta`, read at build time by `src-tauri/build.rs` and
  `vite.config.ts`, moves the browser host to `http://127.0.0.1:18472`
  (`PREFERRED_PORT`, `src/platform/flavor.ts`), off the release app's 18452 and
  the Trellis prototype's 18462.

A build with one half and not the other exits at launch, since it would share
the release app's data or contend for its port. Any other `LATTICE_FLAVOR`
value fails the build. The app lands in
`src-tauri/target/release/bundle/macos/Lattice Beta.app`, ad-hoc signed like a
fork's build (above).

## Rotating the updater signing key

**Last rotated 2026-10-25** (new minisign key ID `B984A4F7ACF6F51B`).

The previous key pair (key ID `352AE3E46AE8C892`) was generated in a third
party's temporary environment (this is stated plainly in the setup notes this
document replaces), delivered to the maintainer as a file, never rotated, and
had an empty password. Anyone who still holds a copy of it can sign an artifact
that every install of 0.12.0 or earlier accepts as a legitimate update, which
is why it was replaced. Deleting the old documentation does not remove it from
git history, and the private key's exposure has nothing to do with this
repository's contents anyway; rotation was the only mitigation.

The current private key has a password. The maintainer generated it locally and
keeps the key and its password in `~/.lattice-secrets/updater-2026-10/` on
their Mac (outside every repository), in the `TAURI_SIGNING_PRIVATE_KEY` and
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` GitHub secrets, and in an offline backup.
Nothing else holds a copy.

The first release built after the rotation has to carry the reinstall warning
from step 5 below. A lead that can go into its `.github/release-notes/vX.Y.Z.md`:

> **Please download and install this version manually, once.** This release is
> signed with a new update key. Copies of Lattice 0.12.0 and earlier only
> trust the old key, so they will not offer this update automatically. Download
> the DMG from this page and install it over your current copy; your projects
> and settings are kept, and automatic updates resume from here on.

Runbook:

1. Generate a new pair:

   ```bash
   pnpm tauri signer generate -w ~/.lattice-secrets/updater-YYYY-MM/updater.key
   ```

   Set a strong password, and write the private key outside every repository
   and worktree.

2. Put the **public** key into `src-tauri/tauri.conf.json` under
   `plugins.updater.pubkey`. Commit that; it is meant to be public.

3. Put the **private** key into the `TAURI_SIGNING_PRIVATE_KEY` GitHub secret
   (the full file contents), and its password into
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Never commit it, never paste it into an
   issue, and do not keep it in a shared drive or chat.

4. Cut the next release normally.

5. **Warn users in the release notes.** Installed copies verify updates against
   the *old* public key, which is compiled into the app they are running. They
   will reject every artifact signed with the new key and will silently stop
   updating. Every existing install has to download and reinstall the DMG once,
   after which automatic updates resume. Say this at the top of the release
   notes for the rotating version, and consider keeping it in the notes for a
   release or two afterwards.

Because of step 5, rotate at a moment you are willing to ask everyone to
reinstall — ideally before the user base grows.
