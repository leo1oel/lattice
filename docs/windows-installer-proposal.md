# Proposal: downloadable experimental Windows installers

Status: **proposal for discussion** following the experimental Windows host
support merged in [#702](https://github.com/leo1oel/lattice/pull/702).
This document does not enable a workflow, publish a binary or change application
updates. It asks for agreement on the next contribution before implementing it.

## Why this would help

The Windows host can now be compiled and tested, but trying it still requires
Rust, Microsoft's C++ build tools, Node and pnpm. Many researchers who could
use Lattice or report Windows issues cannot set up that development environment.

An installer built by GitHub Actions would let them try the application without
compiling it themselves. It would also make bug reports easier to reproduce:
testers could identify the exact version, source commit and build run they used.
This would broaden access to the project and provide more feedback on the
experimental host before committing to official Windows releases.

## Proposed first implementation

Build an **experimental Windows x64 NSIS `.exe` installer** in an independent
GitHub Actions workflow. Upload it as a downloadable Actions artifact after
installation and startup checks pass.

- Keep the upstream product name, application identifier and version.
- Build the selected source commit; do not introduce a separate Windows version.
- Use open-licensed fonts and public dependencies without repository secrets.
- Keep the embedded Agent disabled on Windows, as in the merged host support.
- Keep the current manual TeX and paper-tool setup requirements.
- Keep Word export, Pandoc and changes to the macOS/Linux release jobs outside
  this contribution.
- Leave Windows automatic updates disabled and set
  `bundle.createUpdaterArtifacts` to `false` for this package.

The first installer would be unsigned and clearly described as experimental.
Windows may show publisher/SmartScreen prompts. Authenticode signing and the
policy for an official release would be separate decisions.

## When builds would run

The preferred automatic trigger is **after a successful upstream `Release`
workflow**, with `workflow_dispatch` available for maintainer-requested builds.
This avoids compiling an installer on every commit while still producing one
for new released versions.

The existing Linux AppImage workflow provides a useful model: a separate
`workflow_run` consumer checks that `Release` succeeded and checks out its
`head_sha`, rather than whatever happens to be on `main` afterwards. The Windows
job should also verify the originating repository and release-tag context.
A release event created using `GITHUB_TOKEN` should not be assumed to trigger
another workflow; following the existing `workflow_run` pattern avoids that
dependency.

A Windows failure must not block, modify or retract the macOS release. The first
implementation would have **read-only repository permissions** and would upload
Actions artifacts only. It would not attach assets to GitHub Releases, edit
release notes or modify `latest.json`.

Packaging changes could run the same build and checks on narrowly scoped pull
requests, subject to the repository's approval rules. Those runs would have no
release credentials, use the PR's source, and identify the artifact as a PR build.
The workflow must not use `pull_request_target` to execute contributor code.

For rollout, manual and packaging-PR builds could be introduced first; the
release-following trigger could then be enabled once the installer checks are
reliable and the maintainer agrees with the ongoing CI cost.

## Build and runtime preparation

The implementation would use the repository's checkout/setup conventions,
pinned Rust toolchain, frozen JavaScript lockfiles and a Windows release-build
cache. The initial target would be `x86_64-pc-windows-msvc`; ARM64 and MSI/portable
packages would be left for later work.

A Windows-specific Tauri configuration overlay would select NSIS and disable
updater artifacts without changing the base macOS configuration. The build hook
would need to stage the runtimes Windows actually supports, rather than ship
the compilation-only stub used by the host CI job.

In particular, Open Slide needs a real Node executable and its presentation
runtime. The existing Node release table already includes a pinned Windows x64
archive and SHA-256 digest in `prepare-synara-sidecar.mjs`. The implementation
should reuse or carefully share that pin, carry its redistribution license,
and verify the staged executable's version. Presentation dependencies should
retain the existing frozen-lockfile, materialization, pruning and runtime checks.
Windows command invocation in the preparation scripts also needs to be tested.

This is not a proposal to enable the Synara Agent on Windows. Runtime staging
should be explicit about that distinction, and any new redistributed component
must be reflected in `THIRD_PARTY_NOTICES.md`.

## What testers would download

An artifact named along the lines of
`Lattice-<version>-windows-x64-<short-sha>` would contain:

- the `.exe` installer produced by Tauri;
- a SHA-256 checksum file;
- build information identifying the source commit, version, target and run;
- brief instructions and the experimental feature limitations.

Names and paths must come from the build/version metadata, not a hard-coded
version such as the earlier fork installer name.

GitHub downloads Actions artifacts as a ZIP: the tester would extract it and
run the installer inside. An authenticated GitHub account is normally required
to download them. A proposed initial retention period is 14 days, subject to
the repository's storage policy. These access and expiry limits should be
explained beside the download instructions.

This first stage would therefore provide test builds rather than a permanent,
public release-download channel. Attaching validated installers to Releases
could be discussed separately if the artifact approach proves useful.

## Checks before an installer becomes downloadable

Building an `.exe` is not enough: the packaged resources must work outside the
source checkout. At minimum, a Windows runner should:

1. Verify the expected installer and bundled runtime inventory, including
   licenses and the pinned Node version.
2. Install into an isolated per-user directory without requiring an administrator.
3. Launch the installed application, open the tutorial and verify it remains
   responsive; exercise the terminal and window controls.
4. Confirm that the Agent is reported as unavailable and that supported runtime
   features can find their installed resources, including Open Slide.
5. Exercise uninstall and cleanup in the isolated runner.
6. Upload the installer only after these checks pass, with a concise job summary
   showing the source version and how to download it.

The fork's installed-app e2e scripts can inform this work, but should be adapted
to upstream conventions and reviewed rather than copied wholesale. A LaTeX
tutorial-compilation check is desirable where a test TeX distribution is
available; its installation time and maintenance cost should be agreed first.
TeX would remain an external user prerequisite, not part of the installer.

The first implementation should also document a manual clean-machine Windows
11 check, including the WebView2 prerequisite and per-user install/uninstall.
A successful hosted-runner test alone does not establish compatibility with
every consumer Windows configuration.

## Automatic application updates: a later proposal

If the installer workflow is useful and accepted, a subsequent PR could propose
Windows automatic updates. That work would need agreement on:

- stable versus experimental release channels and eligible source versions;
- signing and verification of Tauri updater artifacts and protection of the
  signing key, separately from Windows Authenticode signing;
- Windows entries in the update metadata, asset checks and failure handling;
- enabling the Windows updater backend/UI, which are currently disabled;
- behavior with unsaved work, failed downloads, invalid signatures and failed
  installation, without discarding user projects.

Updates should download an already compiled, verified application. They should
not run `git pull`, install a compiler or build source on the user's computer.
No automatic-update implementation or signing-key setup is requested by this
proposal.

## Decisions requested before implementation

1. Is an experimental Actions artifact the right next step after #702?
2. Should automatic builds follow successful Releases, or would manual builds
   be preferable until more Windows installation feedback is available?
3. Are x64 NSIS, open-licensed fonts, a per-user install and a 14-day artifact
   lifetime an acceptable initial scope?
4. Which installed-app checks should gate the first downloadable build, and
   would a separate TeX integration job be worthwhile?

Once the scope is agreed, the workflow/configuration and its Windows validation
would be proposed as a separate implementation PR. Signing, publication as
official release assets and automatic updates would remain explicit later steps.
