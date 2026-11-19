# App updater

One of the features [the GPUI app](../README.md) has so far.

Updates the app as the Tauri app's updater does (`src/telemetry/app-updater.tsx`), from the GPUI app's own release channel, and ships off: it does nothing until the writer turns on Settings › Editor & builds › Beta updates (`appUpdates` in the settings file, off by default).
Until then the updater checks nothing, Lattice ▸ Check for Updates… is not in the menu, the Version row links to GitHub Releases, and Report a problem files the report at once.

With Beta updates on, it reads the GPUI channel's release manifest (`latest.json`, in the shape the Tauri app's updater reads) at once, then at launch and every six hours, and offers a newer release for this platform ("New version …", Update now); the Version row's Check for updates checks at once.
Update now downloads the archive with its progress, checks its minisign signature against the channel's key, and puts the app bundle it holds in place of the running one, unpacked beside it first so the swap is two renames; a failure says why ("Lattice update failed") and keeps the running app.
Once installed, Update now restarts into the release, asking first while a build runs ("Restart Lattice now?"); every window writes its open edits as the app quits.
Lattice ▸ Check for Updates… checks at once and says when Lattice is up to date, and becomes Restart to Update… once an update is installed.
Report a problem offers a release the updater knows of first ("You’re on vX; vY is available", Update now or Report anyway).

## The channel

- **Feed:** `https://github.com/leo1oel/lattice/releases/download/lattice-beta/latest.json` (`GPUI_ENDPOINT` in `crates/lattice-gpui/src/updater.rs`), an asset of one prerelease tagged `lattice-beta` that only GPUI builds go to. A prerelease is never GitHub's latest release, so the Tauri app's `releases/latest/download/latest.json` never sees it, and its tag matches neither `release.yml` nor `gpui.yml` (`v*`).
- **Signatures:** the Tauri updater's scheme and key: minisign over the `.app.tar.gz`, made by `tauri signer sign` with `TAURI_SIGNING_PRIVATE_KEY`, checked against `plugins.updater.pubkey` in `src-tauri/tauri.conf.json`, which the app reads at build time. A GPUI archive could only reach a Tauri install through the Tauri feed, and the two feeds never share a file.
- **Versions:** the app's version is `lattice-core`'s, which follows the Tauri app's (`scripts/bump-version.mjs`), and the manifest carries the same number, so a GPUI build is offered only a newer release.
- **Packages:** `../../scripts/gpui-bundle.mjs` builds `Lattice Beta.app` (identifier `app.leo1oel.lattice-beta`), signs and notarizes it, and writes the `.dmg`, `.zip`, `Lattice-Beta_<version>_aarch64.app.tar.gz` with its `.sig`, and `latest.json` pointing at the archive on the feed. `.github/workflows/gpui-package.yml` (run by hand) makes them with the release secrets and keeps them as the run's artifact; it publishes nothing.
- **Publishing (by hand, after a hand test of the artifact):** create the prerelease once (`gh release create lattice-beta --prerelease --title "Lattice Beta channel" --notes …`), then for each build upload the archive and its `.sig` first and `latest.json` last, `--clobber`, so a check never reads a manifest whose archive is not there yet.

## In the e2e scenario

`scenario/e2e/updater.rs`: the updater off, with no menu item; then pointed at a channel on disk with Beta updates turned on, a check offering the newer release and adding Check for Updates…, Report a problem offering it first, and Update now checking the archive's signature and saying why it could not install it outside an app bundle.
