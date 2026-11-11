# Experimental Windows installer

Status: implementation of the proposal approved in
[#755](https://github.com/leo1oel/lattice/pull/755#issuecomment-6750626845),
following the experimental Windows host merged in #702.

## Downloads

Successful upstream releases receive four public, non-expiring assets:

- `Lattice_<version>_windows-x64-experimental-setup.exe`: unsigned x64 NSIS installer;
- matching `.sha256`, `.build-info.json` and `.README.txt` assets with the
  checksum, source commit, Actions run and installation/SmartScreen notes.

The names and asset labels explicitly say experimental. Users do not need a
GitHub account to download them. The application retains the upstream name,
identifier and release version. No Windows-specific version is introduced.

The installer is per-user and needs no administrator privileges. Microsoft Edge
WebView2 is required; NSIS offers the official bootstrapper if it is missing.
Windows 10 1809 or later is required; Windows 11 is recommended. LaTeX compiles
with a TeX distribution: Lattice's setup dialog installs TeX Live for the current
user (no administrator prompt), or install TeX Live or MiKTeX yourself. The
embedded Agent stays off, rtex is unavailable, and updates are manual.

This build is unsigned. SmartScreen may warn about the unknown publisher.
Verify the asset's origin and SHA-256 before deciding whether to run it;
do not disable SmartScreen or antivirus. Authenticode, signed updater artifacts,
Windows update metadata and enabling the updater remain separate future work.

## Independent workflow

`.github/workflows/windows-installer.yml` follows a successful upstream `Release`
workflow using `workflow_run`, checking out that run's exact `head_sha` and
verifying its tag still resolves to the same commit and version. A Windows
failure cannot prevent or retract the already published Mac release.

`workflow_dispatch` and packaging-related `pull_request` runs execute the same
checks without publishing. No `pull_request_target` code execution is used.
All successful builds also keep an Actions ZIP for 14 days; that convenience
download requires a GitHub login and expires. It is not the public release channel.

Builds have read-only repository permissions and no repository secrets. They use
the pinned Rust toolchain, Node/pnpm setup conventions, frozen pnpm lockfiles,
MSVC/Windows SDK on the hosted runner and a separate Windows release cache.
Open-licensed interface fonts are used. There are no private fonts or baked-in
product-license keys; tldraw is in its unlicensed mode without a key.

Only the final `attach` job gets `contents: write`, after all installation and
native checks passed. It downloads the exact artifact ID from that run and
executes publication code from the trusted workflow revision, never code in an
artifact or contributor revision. It checks metadata, executable signature
bytes and checksum again, rejects foreign/failed/manual/non-tag contexts, and
resolves the published release's tag to the tested commit before uploading.
Reruns replace only the four exact versioned Windows names. Mac/Linux assets,
release text and `latest.json` are not edited.

## Supported runtime preparation

The Windows Tauri overlay selects NSIS/current-user installation and disables
updater artifacts without changing the base configuration. Its preparation hook
stages only the runtimes Windows supports:

- a standalone `node.exe`, using the same pinned archive table and SHA-256
  verification as Synara, plus `licenses/Node-LICENSE.txt`;
- the existing Open Slide runtime, with frozen installation, link
  materialization, pruning and its real module-graph check.

Node remains under `synara-runtime/bin`, the location already resolved by the
native presentation supervisor. The manifest explicitly marks the Agent
unavailable; no compilation stub or Synara server is shipped. No Pandoc, uv,
Word export, ARM64 package or portable/MSI package is added.

## Gates before a download is published

On a disposable Windows runner, the workflow:

1. Builds exactly one NSIS installer and installs it silently into an isolated
   per-user directory. It refuses an existing Lattice installation/process.
2. Checks the installed application version, Node pin/version/license,
   presentation inventory, Agent-free manifest and loose-font rules.
3. Runs Open Slide's existing module-graph check with the **installed Node**.
4. Starts the **installed executable** from its installation directory and
   drives its real WebView2/IPC through Playwright CDP. On elevated hosted
   runners, WebView2 150+ ignores environment overrides, so a temporary HKLM
   additional-arguments value enables a loopback port for `research-writer.exe`
   only. The test refuses an existing value and removes its own value in
   `finally`; the script refuses to run outside a disposable Windows runner.
   No wildcard policy, application debug hook or installer setting is added.
5. Opens and reads the tutorial, verifies the Agent is unavailable, enters and
   leaves native fullscreen with F11, round-trips Unicode file replacement,
   executes a real ConPTY shell command and resize, and starts Open Slide
   through the installed native host's resource paths.
6. Uninstalls and checks that the executable and registration are gone.
7. Only then creates the checksum/metadata/instructions and uploads the checked
   installer. Failures retain diagnostic logs/screenshots, not an installer.

The runner does not install TeX or assert that a LaTeX build succeeds. That
integration check can be added separately once its CI cost is agreed. The
workflow also does not establish consumer SmartScreen reputation.

Before calling Windows support stable, manually test a clean Windows 11 account:
download without signing in, verify SHA-256, inspect publisher/SmartScreen
behavior, install without elevation, test WebView2 bootstrap if absent, open a
project, compile it with separately installed TeX Live, exercise window controls,
terminal and presentations, then uninstall and confirm project files remain.
A hosted-runner check is not a substitute for this clean-machine review.
