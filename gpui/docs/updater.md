# App updater

One of the features [the GPUI app](../README.md) has so far.

Updates the app as the Tauri app's updater does (`src/telemetry/app-updater.tsx`), and ships off.
The GPUI app has no release channel yet, and none is used until one is approved: `GPUI_CHANNEL` in `crates/lattice-gpui/src/updater.rs` is where its manifest and the public key that signs its archives go.
Until then the updater checks nothing, Lattice ▸ Check for Updates… is not in the menu, and Report a problem files the report at once.

With a channel, it reads the release manifest the Tauri app's updater reads (`latest.json`) at launch and every six hours, and offers a newer release for this platform ("New version …", Update now).
Update now downloads the archive with its progress, checks its minisign signature against the channel's key, and puts the app bundle it holds in place of the running one, unpacked beside it first so the swap is two renames; a failure says why ("Lattice update failed") and keeps the running app.
Once installed, Update now restarts into the release, asking first while a build runs ("Restart Lattice now?"); every window writes its open edits as the app quits.
Lattice ▸ Check for Updates… checks at once and says when Lattice is up to date, and becomes Restart to Update… once an update is installed.
Report a problem offers a release the updater knows of first ("You’re on vX; vY is available", Update now or Report anyway).

## In the e2e scenario

`scenario/e2e/updater.rs`: the updater off, with no menu item; then pointed at a channel on disk, a check offering the newer release and adding Check for Updates…, Report a problem offering it first, and Update now checking the archive's signature and saying why it could not install it outside an app bundle.
