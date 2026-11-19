# App updater

One of the features [the GPUI app](../README.md) has so far.

Updates the app as the Tauri app's updater does (`src/telemetry/app-updater.tsx`). The GPUI binary ships as two apps (`crates/lattice-gpui/src/flavor.rs`, read from the bundle's identifier), and each updates from its own feed:

- **Lattice** (`app.leo1oel.researchwriter`, the Tauri app's identity, from 0.19.0 on Apple silicon Macs) follows the Tauri app's feed, always, as the Tauri app does. Settings › Editor & builds shows only the Version row with Check for updates.
- **Lattice Beta** (`app.leo1oel.lattice-beta`, beside the Tauri app) follows its own channel and ships off: it does nothing until the writer turns on Settings › Editor & builds › Beta updates (`appUpdates` in the settings file, off by default). Until then the updater checks nothing, Lattice ▸ Check for Updates… is not in the menu, the Version row links to GitHub Releases, and Report a problem files the report at once. A binary outside a bundle (a build tree, the e2e) is Lattice Beta.

While it is on, it reads the release manifest (`latest.json`, in the shape the Tauri app's updater reads) at once, then at launch and every six hours, and offers a newer release for this platform ("New version …", Update now); the Version row's Check for updates checks at once.
Update now downloads the archive with its progress, checks its minisign signature against the channel's key, and puts the app bundle it holds in place of the running one, unpacked beside it first so the swap is two renames; a failure says why ("Lattice update failed") and keeps the running app.
Once installed, Update now restarts into the release, asking first while a build runs ("Restart Lattice now?"); every window writes its open edits as the app quits.
Lattice ▸ Check for Updates… checks at once and says when Lattice is up to date, and becomes Restart to Update… once an update is installed.
Report a problem offers a release the updater knows of first ("You’re on vX; vY is available", Update now or Report anyway).

## Lattice: the Tauri app's successor on Apple silicon

From 0.19.0 the Tauri app's own updater moves Apple silicon Macs to the GPUI app. The design note is `handoffs/LATA-45/design.md` in the Captain drive. In short:

- **Identity:** `scripts/gpui-bundle.mjs --flavor main` builds `Lattice.app` with the Tauri app's identifier and Developer ID. The Tauri updater unpacks it over the running `Lattice.app` and relaunches the executable its `Info.plist` names, so macOS privacy grants, Keychain items (one service for both apps) and the Dock place carry over.
- **Data:** it keeps its own folder, `~/Library/Application Support/app.leo1oel.lattice` (and the same name under Caches). Its first launch carries the Tauri app's state over (`lattice_settings::migrate`, once, read-only on the Tauri app's folder) and announces the update (What's new). Lattice Beta's `lattice-gpui` is left alone.
- **Feed:** `.github/workflows/release.yml` builds both apps. While `scripts/release-apps.json` says `gpui`, its `publish` job uploads the GPUI app's dmg and archive under tauri-action's names, replacing the Tauri app's, and gives latest.json's `darwin-aarch64` and `darwin-aarch64-app` entries the GPUI archive's signature (`scripts/replace-updater-archive.mjs`, checked against the updater key). Intel Macs, Windows and Linux keep their Tauri entries.
- **Rollback:** set `darwin-aarch64` to `tauri` in `scripts/release-apps.json` and release a higher version. Lattice's updater installs that Tauri build the same way, and the Tauri app finds its own folder as it left it.

## The channels

- **Lattice's feed:** `https://github.com/leo1oel/lattice/releases/latest/download/latest.json`, the Tauri app's (`plugins.updater.endpoints` in `src-tauri/tauri.conf.json`; `crate::flavor` tests that they match).
- **Lattice Beta's feed:** `https://github.com/leo1oel/lattice/releases/download/lattice-beta/latest.json`, an asset of one prerelease tagged `lattice-beta` that only Lattice Beta builds go to. A prerelease is never GitHub's latest release, so the Tauri app's `releases/latest/download/latest.json` never sees it, and its tag matches neither `release.yml` nor `gpui.yml` (`v*`).
- **Another feed:** `LATTICE_GPUI_UPDATER_ENDPOINT` names a manifest to read instead (an `http(s)` or `file://` URL), for rehearsing a release against a local feed. What it offers is still checked against the updater key and installed only when newer.
- **Signatures:** the Tauri updater's scheme and key: minisign over the `.app.tar.gz`, made by `tauri signer sign` with `TAURI_SIGNING_PRIVATE_KEY`, checked against `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, which the app reads at build time.
- **Versions:** the app's version is `lattice-core`'s, which follows the Tauri app's (`scripts/bump-version.mjs`), and the manifest carries the same number, so a GPUI build is offered only a newer release.
- **Packages:** `../../scripts/gpui-bundle.mjs [--flavor beta|main]` builds `Lattice Beta.app` or `Lattice.app`, signs and notarizes it, and writes the `.dmg`, `.zip`, `Lattice-Beta_<version>_aarch64.app.tar.gz` (or `Lattice_<version>_aarch64.app.tar.gz`) with its `.sig`, and `latest.json` pointing at the archive on the feed. `.github/workflows/gpui-package.yml` makes them with the release secrets and keeps them as the run's artifact; it publishes nothing. It runs by hand (either flavor) or from `release.yml` (Lattice).
- **Publishing Lattice Beta (by hand, after a hand test of the artifact):** create the prerelease once (`gh release create lattice-beta --prerelease --title "Lattice Beta channel" --notes …`), then for each build upload the archive and its `.sig` first and `latest.json` last, `--clobber`, so a check never reads a manifest whose archive is not there yet.

## In the e2e scenario

`scenario/e2e/updater.rs`: the updater off, with no menu item; then pointed at a channel on disk with Beta updates turned on, a check offering the newer release and adding Check for Updates…, Report a problem offering it first, and Update now checking the archive's signature and saying why it could not install it outside an app bundle.
