# Release process

How a Lattice release is actually cut today. Everything below is derived from
`scripts/bump-version.mjs`, `.github/workflows/release.yml`,
`.github/workflows/release-cache.yml`, and `src-tauri/tauri.conf.json`; if you
change one of those, change this document with it.

Releases target **Apple Silicon macOS only** (`--target aarch64-apple-darwin`,
`minimumSystemVersion: 14.0`).

## Cut a release

```bash
node scripts/bump-version.mjs patch     # or: minor | major | 0.3.0
```

The script only edits files — it does not commit or tag. It bumps the version in
lockstep across `package.json`, `src-tauri/tauri.conf.json`,
`src-tauri/Cargo.toml`, and the `research-writer` entry in
`src-tauri/Cargo.lock`, then prints the exact next commands:

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
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
— a breaking change, a migration, the updater-key rotation warning below — has to
be added to the release body by hand after the workflow publishes it.

## What `release.yml` does

One job on `macos-latest` (Apple Silicon), with `contents: write` so it can
create the Release and upload assets.

1. **Checkout** with `fetch-depth: 0` — the release notes need the full tag
   history.
2. **Generate release notes.** Finds the nearest released ancestor tag with
   `git describe --tags --abbrev=0 <tag>^`, lists every non-merge commit in that
   range as `- <subject> (<short hash>)`, and skips the `Release v…` commit
   itself. Falls back to "Maintenance release." when the range is empty. Appends
   the Apple Silicon install blurb and a `**Full Changelog**` compare link, then
   passes the whole thing to the build step through a heredoc-delimited
   `$GITHUB_OUTPUT`.
3. **Toolchains.** pnpm 10, Node 22, Bun 1.3.14, stable Rust with the
   `aarch64-apple-darwin` target.
4. **Rust cache.** `Swatinem/rust-cache@v2` with
   `shared-key: aarch64-apple-darwin-release` and `save-if: false`. It *reads*
   the warm dependency build produced by `release-cache.yml` on `main`; a tag
   build can never write a cache any later release could read, so it does not
   try.
5. **`pnpm install --frozen-lockfile`.**
6. **Fetch the pinned Synara source.** Reads `repository` and `revision` from
   `scripts/synara-runtime.json`, shallow-fetches exactly that revision into
   `$RUNNER_TEMP/lattice-synara`, asserts `HEAD` equals the pinned revision,
   runs `bun install --frozen-lockfile`, and exports `SYNARA_SOURCE_DIR` and
   `BUN_BIN` for the build. The sidecar is staged later by
   `pnpm prepare:runtime`, which `tauri.conf.json` runs as
   `beforeBuildCommand`.
7. **Import the Apple Developer ID certificate.** Base64-decodes
   `APPLE_CERTIFICATE` into a `.p12`, creates a throwaway keychain, imports the
   certificate with `-T /usr/bin/codesign`, sets the key partition list so
   codesign can use it without prompting, makes it the active keychain, then
   greps `security find-identity` for the `Developer ID Application` identity
   and exports it as `APPLE_SIGNING_IDENTITY`.
8. **Prepare the App Store Connect API key.** Writes `APPLE_API_PRIVATE_KEY` to
   `$RUNNER_TEMP/AuthKey_$APPLE_API_KEY.p8` with mode 600 and exports
   `APPLE_API_KEY_PATH`.
9. **Build, sign, and publish** with `tauri-apps/tauri-action@v0`:
   - `args: --target aarch64-apple-darwin` (this is what makes the updater
     platform key `darwin-aarch64`);
   - `releaseDraft: true` — the Release stays a **draft** until verification
     passes;
   - `includeUpdaterJson: true` — generates and uploads `latest.json`, which the
     in-app updater reads from
     `https://github.com/leo1oel/lattice/releases/latest/download/latest.json`
     (see `plugins.updater.endpoints` in `tauri.conf.json`);
   - `TAURI_SIGNING_PRIVATE_KEY` / `..._PASSWORD` sign the updater artifact
     (`bundle.createUpdaterArtifacts` is on);
   - `LATTICE_FIRECRAWL_KEY` is compiled into the binary here via `option_env!`
     in `src-tauri/src/firecrawl.rs`. It is extractable from the shipped app —
     that is a known and accepted trade-off; rotate it on abuse.
10. **Notarize.** `xcrun notarytool submit <dmg> --wait` with the API key, then
    `xcrun stapler staple <dmg>`.
11. **Verify before publishing.** On the DMG: `codesign --verify --strict`,
    `spctl --assess --type open --context context:primary-signature`, and
    `xcrun stapler validate`. Then it mounts the DMG and repeats on the `.app`
    inside: `codesign --verify --deep --strict`, `spctl --assess --type
    execute`, `xcrun stapler validate`.
12. **Upload the stapled DMG** with `gh release upload --clobber` (the stapled
    ticket is added after tauri-action's own upload, so the asset is replaced).
13. **Publish** with `gh release edit "$GITHUB_REF_NAME" --draft=false`.

If any verification step fails, the Release simply stays a draft and nothing
reaches users.

### `release-cache.yml`

A separate workflow on `main` that warms the `aarch64-apple-darwin-release`
Rust cache so tag builds do not compile the dependency graph from scratch. It
deliberately does **not** set `LATTICE_FIRECRAWL_KEY`, so the key never lands in
a cache artifact.

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

## Rotating the updater signing key

**Read this before the first public release.**

The key pair currently in use was generated in a third party's temporary
environment (this is stated plainly in the setup notes this document replaces),
and the private key was delivered to the maintainer as a file. It has **never
been rotated**: the `plugins.updater.pubkey` value in
`src-tauri/tauri.conf.json` has exactly one commit in its history. Its password
is the empty string.

Anyone who still holds a copy of that private key can sign an artifact that
every installed Lattice will accept as a legitimate update. Rotation is the only
mitigation — deleting the old documentation does not remove it from git history,
and the private key's exposure has nothing to do with this repository's
contents anyway.

Runbook:

1. Generate a new pair:

   ```bash
   pnpm tauri signer generate -w ~/.lattice/updater.key
   ```

   Set a real password this time; the empty-string password is why
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is currently blank.

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
